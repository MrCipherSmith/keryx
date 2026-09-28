// Flow 358 — the host side of the tier-ranking agent fallback.
//
// `src/gdskills/model-tier.ts` stays pure: it defines the `TierRankAgent` and
// `TierRankCache` PORTS, validates what comes back, and decides. This file holds the
// three things that touch the outside world and therefore cannot live there:
//
//   - the agent itself: one fail-closed provider turn (`runModelTurn`) on the
//     light tier of the session's own provider, which is exactly the `runOn` the
//     request carries, so no other provider is ever called and no credential the
//     session does not already hold is read;
//   - the cache: `tier-rank-cache.json` next to `model-profiles.json` in the keryx
//     config dir, mode 0600, written atomically under the same kind of file lock,
//     keyed by the catalogue hash so an unchanged catalogue asks the agent once;
//   - the prices: the operator's own model profiles, numeric fields only. An
//     "unknown" price is passed on as absent, never as zero.
//
// The agent is shown discovered model ids and profile prices and nothing else — the
// prompt is built by `buildRankPrompt` and carries no task, no diff and no user text.
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../../lib/config-dir";
import { withFileLock } from "../../lib/fs";
import {
  rankCatalogueHash,
  type ModelPrices,
  type TierRankAgent,
  type TierRankCache,
  type TierRankRequest,
} from "../../gdskills/model-tier";
import { runModelTurn, type ModelTurnInput } from "../provider/single-turn";
import { loadModelProfiles, type ModelProfile } from "./model-profile";

const TIER_RANK_CACHE_FILE = "tier-rank-cache.json";
const TIER_RANK_CACHE_VERSION = 1;
/** Old entries are dropped past this many; a catalogue changes rarely, so this is generous. */
const TIER_RANK_CACHE_MAX_ENTRIES = 64;
const CACHE_LOCK = { timeoutMs: 3_000, retryMs: 15, staleMs: 10_000 } as const;

/** Output budget for one ranking answer: a JSON list of ids is a few hundred tokens at most. */
const RANK_MAX_OUTPUT_TOKENS = 512;

/** How long a failed ranking is remembered in this process, so a dead provider is asked once, not per dispatch. */
export const RANK_FAILURE_MEMO_MS = 5 * 60_000;

const RANK_SYSTEM_PROMPT =
  "You compare AI language models with each other and answer with a single JSON object. You never see or judge any task.";

/** Absolute path to `tier-rank-cache.json`, the sibling of `model-profiles.json`. */
export function tierRankCacheFilePath(dir?: string): string {
  return path.join(keryxConfigDir(dir), TIER_RANK_CACHE_FILE);
}

interface StoredEntry {
  readonly order: readonly string[];
  readonly at: string;
}

function readEntries(dir?: string): Record<string, StoredEntry> {
  const read = readConfigFile(tierRankCacheFilePath(dir));
  if (!read.ok) return {};
  try {
    const parsed = JSON.parse(read.text) as { version?: unknown; entries?: unknown };
    if (parsed.version !== TIER_RANK_CACHE_VERSION) return {};
    if (typeof parsed.entries !== "object" || parsed.entries === null || Array.isArray(parsed.entries)) return {};
    const out: Record<string, StoredEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { order, at } = value as { order?: unknown; at?: unknown };
      if (!Array.isArray(order) || !order.every((id) => typeof id === "string") || typeof at !== "string") continue;
      out[key] = { order: order as string[], at };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The file-backed cache. `get` never throws and never locks (a missing or damaged
 * file is a miss); `set` is a locked read-merge-write, so two sessions ranking
 * different catalogues do not clobber each other. Only VALIDATED orders are handed
 * to `set` by the module — a failure is never cached here.
 */
export function createTierRankFileCache(dir?: string, now: () => number = Date.now): TierRankCache {
  return {
    async get(key) {
      return readEntries(dir)[key]?.order;
    },
    async set(key, order) {
      ensureKeryxConfigDir(dir);
      await withFileLock(
        `${tierRankCacheFilePath(dir)}.lock`,
        async () => {
          const entries = { ...readEntries(dir), [key]: { order: [...order], at: new Date(now()).toISOString() } };
          const kept = Object.entries(entries)
            .sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
            .slice(0, TIER_RANK_CACHE_MAX_ENTRIES);
          writeOwnerOnlyFileAtomic(
            tierRankCacheFilePath(dir),
            `${JSON.stringify({ version: TIER_RANK_CACHE_VERSION, entries: Object.fromEntries(kept) }, null, 2)}\n`,
          );
        },
        CACHE_LOCK,
      );
    },
  };
}

/**
 * Prices for one provider's models out of the operator's profiles, numeric fields
 * only. A model with no known price on either axis is left out entirely.
 */
export function modelPricesFromProfiles(
  providerId: string,
  profiles: Readonly<Record<string, ModelProfile>>,
): ModelPrices {
  const prices: Record<string, { inputPerMillion?: number; outputPerMillion?: number }> = {};
  for (const profile of Object.values(profiles)) {
    if (profile.providerId !== providerId) continue;
    const input = profile.priceInputPerMillion.value;
    const output = profile.priceOutputPerMillion.value;
    const price: { inputPerMillion?: number; outputPerMillion?: number } = {};
    if (typeof input === "number") price.inputPerMillion = input;
    if (typeof output === "number") price.outputPerMillion = output;
    if (price.inputPerMillion !== undefined || price.outputPerMillion !== undefined) prices[profile.modelId] = price;
  }
  return prices;
}

/** The session provider's prices as the operator's profiles (plus the curated seed) hold them. Never throws. */
export function loadModelPrices(providerId: string, dir?: string): ModelPrices {
  try {
    return modelPricesFromProfiles(providerId, loadModelProfiles(dir));
  } catch {
    return {};
  }
}

export interface TierRankAgentDeps {
  /** Injected in tests; defaults to the real one-shot provider turn. */
  readonly runTurn?: (input: ModelTurnInput) => Promise<{ text: string; credentialAvailable: boolean; error?: { message?: string } }>;
  readonly now?: () => number;
  /** Passed through to the turn (tests: env, fetch, provider factory). */
  readonly turnOptions?: Partial<ModelTurnInput>;
}

/**
 * The real agent: one provider turn on `request.runOn`, which the module already
 * resolved to the light tier of the session's own provider. It throws on a missing
 * credential or a provider error — the module turns any throw into "the session
 * model stays" — and remembers a failure for {@link RANK_FAILURE_MEMO_MS} in this
 * process so a dead or credential-less provider costs one attempt, not one per
 * dispatch.
 */
export function createTierRankAgent(deps: TierRankAgentDeps = {}): TierRankAgent {
  const run = deps.runTurn ?? runModelTurn;
  const now = deps.now ?? Date.now;
  const failures = new Map<string, { at: number; message: string }>();

  return async (request: TierRankRequest): Promise<string> => {
    const key = rankCatalogueHash(request.providerId, request.candidates);
    const failed = failures.get(key);
    if (failed !== undefined && now() - failed.at < RANK_FAILURE_MEMO_MS) {
      throw new Error(`${failed.message} (remembered for this process)`);
    }
    try {
      const result = await run({
        ...deps.turnOptions,
        provider: request.runOn.providerId,
        model: request.runOn.modelId,
        system: RANK_SYSTEM_PROMPT,
        user: request.prompt,
        maxOutputTokens: RANK_MAX_OUTPUT_TOKENS,
        temperature: 0,
        requestId: "keryx-tier-rank",
      });
      if (!result.credentialAvailable) throw new Error(`no credential for provider "${request.runOn.providerId}"`);
      if (result.error !== undefined) throw new Error(result.error.message ?? "the provider reported an error");
      if (result.text.trim().length === 0) throw new Error("the provider returned no text");
      return result.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(key, { at: now(), message });
      throw error;
    }
  };
}

/** The three host-side pieces a dispatch needs, wired to the real config dir. */
export interface TierRankHost {
  readonly agent: TierRankAgent;
  readonly cache: TierRankCache;
  readonly prices: (providerId: string) => ModelPrices;
}

export function createTierRankHost(dir?: string): TierRankHost {
  return {
    agent: createTierRankAgent(),
    cache: createTierRankFileCache(dir),
    prices: (providerId) => loadModelPrices(providerId, dir),
  };
}

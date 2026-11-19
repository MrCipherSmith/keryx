import { loadModelProfiles, profileKey, type ModelProfile } from "./model-profile";

/**
 * OpenAI's documented flat discount on cache-READ input tokens — 50% of the
 * standard input price, the same fraction across every model that supports
 * prompt caching (research: OpenAI's published Responses/Chat pricing).
 * Applied here rather than as a new per-model `ModelProfile` field: it is a
 * provider-wide constant, not a per-model fact `model-profile.ts` would need
 * to store, refresh, or let an operator override.
 */
const OPENAI_CACHED_INPUT_DISCOUNT = 0.5;

/**
 * flow 387 T16 — Anthropic prompt-caching multipliers on the base input rate
 * (claude-api skill, Prompt Caching: reads ~0.1x, 5-minute-TTL writes ~1.25x).
 * Provider-wide defaults like the OpenAI constant above; some newest models
 * publish a lower read rate (e.g. Opus 5.5 $0.20 on $4 = 0.05x), so this is a
 * conservative (slightly high) estimate there, never an undercount.
 */
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * `undefined` when either price is `"unknown"` or `profile` itself is — never
 * a fabricated number, mirroring `NumericProfileField`'s own "unknown, never
 * 0" contract. `cacheReadTokens` (flow 354, L-11) is a SUBSET of
 * `inputTokens` (never additional to it — see `NormalizedUsage.
 * cacheReadTokens`'s own doc), billed at `OPENAI_CACHED_INPUT_DISCOUNT` ONLY
 * for `providerId` `"openai"`/`"openai-codex"` (review r1, item 2): that rate
 * is OpenAI's own documented number. `"anthropic"` (flow 387 T16) bills
 * `cacheReadTokens` at `ANTHROPIC_CACHE_READ_MULTIPLIER` and the disjoint
 * `cacheWriteTokens` subset at `ANTHROPIC_CACHE_WRITE_MULTIPLIER`. Any OTHER
 * provider's cache hit is billed at the FULL input rate until its own rate is
 * researched, never a fabricated guess. Absent/`0` cache counts reproduce the
 * pre-L-11 all-full-price calculation exactly.
 */
export function estimateTaskCostUsd(
  profile: ModelProfile | undefined,
  providerId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): number | undefined {
  if (profile === undefined) return undefined;
  const priceIn = profile.priceInputPerMillion.value;
  const priceOut = profile.priceOutputPerMillion.value;
  if (priceIn === "unknown" || priceOut === "unknown") return undefined;
  // 1 = full input rate (no discount) — the honest default until a provider's
  // OWN cached-input rate is researched and named here explicitly.
  let cacheReadMultiplier = 1;
  let cacheWriteMultiplier = 1;
  if (providerId === "openai" || providerId === "openai-codex") {
    cacheReadMultiplier = OPENAI_CACHED_INPUT_DISCOUNT;
  } else if (providerId === "anthropic") {
    // flow 387 T16: Anthropic's adapter folds cache reads AND writes into
    // `inputTokens` (both subsets), each billed at its own multiple of the
    // input rate.
    cacheReadMultiplier = ANTHROPIC_CACHE_READ_MULTIPLIER;
    cacheWriteMultiplier = ANTHROPIC_CACHE_WRITE_MULTIPLIER;
  }
  const cacheRead = cacheReadTokens !== undefined && cacheReadTokens > 0 ? Math.min(cacheReadTokens, inputTokens) : 0;
  // Reads and writes are disjoint subsets: clamp the write count to what the
  // reads left over so the pair can never exceed `inputTokens` (no double counting).
  const cacheWrite = cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? Math.min(cacheWriteTokens, inputTokens - cacheRead) : 0;
  const fullPriceInputTokens = inputTokens - cacheRead - cacheWrite;
  const inputCost =
    (fullPriceInputTokens / 1_000_000) * priceIn +
    (cacheRead / 1_000_000) * priceIn * cacheReadMultiplier +
    (cacheWrite / 1_000_000) * priceIn * cacheWriteMultiplier;
  return inputCost + (outputTokens / 1_000_000) * priceOut;
}

/**
 * Flow 468 (AC20) — the running cost of a turn for the busy footer: the same
 * estimate `recordTurnTaskCostBestEffort` records, from the operator's stored
 * model-profile pricing. `undefined` when the price is not known (so the footer
 * shows no cost rather than a guess) or the profile store cannot be read.
 */
export function estimateTurnCostUsd(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly userConfigDir?: string;
}): number | undefined {
  try {
    const profile = loadModelProfiles(input.userConfigDir)[profileKey(input.providerId, input.modelId)];
    return estimateTaskCostUsd(
      profile,
      input.providerId,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens,
      input.cacheWriteTokens,
    );
  } catch {
    // An unreadable profile store means "price unknown", never an error in the turn.
    return undefined;
  }
}

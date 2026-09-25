// Flow 309 — the live provider catalog's on-disk cache: what
// `refreshProviderCatalog` (`./provider-catalog.ts`) writes and what every
// reader (the `/routing` picker, `/connect`, `keryx providers status`) loads
// between refreshes.
//
// Split out of `provider-catalog.ts` so this file can stay a LEAF: it depends
// on nothing that depends back on it. `provider-catalog.ts` (the refresher)
// imports `../commands/providers` for the live `/models`/balance fetch — and
// `commands/providers.ts`'s own `providers test` (flow 304) needs to patch
// THIS cache (AC3: "`providers test` updates the same cache"), which would be
// a cycle if the cache lived in the refresher module. Kept here, both sides
// import only what they need and neither imports the other.
//
// No credential ever appears in this file's types or on disk: an entry
// carries `models`/`status`/`balance`/`fetchedAt`, never an API key or a
// Bearer header — `sanitizeEntry` also refuses to round-trip any OTHER field
// a hand-edited cache file might carry, so a manually added `apiKey` field
// (however it got there) is dropped on the next load rather than echoed back
// out by a reader of this cache.

import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { withFileLock } from "../lib/fs";
import type { ModelsResolveResult, ProviderBalance } from "../commands/providers";

/**
 * AC1's five states. `not-supported` is a native adapter with no live
 * listing endpoint (anthropic/openai/gemini today) — connected (a key is
 * present) but never probed, because there is nothing to probe.
 */
export type ProviderCatalogStatus = "ok" | "auth-failed" | "unreachable" | "timeout" | "not-supported";

const CATALOG_STATUSES: ReadonlySet<string> = new Set(["ok", "auth-failed", "unreachable", "timeout", "not-supported"]);

export interface ProviderCatalogEntry {
  readonly name: string;
  readonly label?: string;
  readonly status: ProviderCatalogStatus;
  /** LIVE fetched model ids — populated only when `status === "ok"`. Empty otherwise; a reader wanting a fallback list uses `fallbackModels`. */
  readonly models: readonly string[];
  /** The registry/native curated list, carried through so a caller can show it as a clearly marked "(offline list)" fallback (AC4) without a second lookup. */
  readonly fallbackModels: readonly string[];
  readonly fetchedAt: string;
  /** Present only for a provider with a documented balance endpoint that answered (AC5). Never a guess. */
  readonly balance?: ProviderBalance;
}

export interface ProviderCatalog {
  /** When this catalog snapshot was assembled (the LATEST of its entries' `fetchedAt`, in practice all equal — one refresh pass). */
  readonly fetchedAt: string;
  readonly providers: Readonly<Record<string, ProviderCatalogEntry>>;
}

/** Freshness window (AC3): a cache younger than this is used immediately, without a refresh. */
export const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

const CATALOG_CACHE_FILE = "provider-catalog.json";
const CACHE_LOCK_TIMEOUT_MS = 250;
const CACHE_LOCK_RETRY_MS = 10;
const CACHE_LOCK_STALE_MS = 5_000;

function catalogFile(dir?: string): string {
  return path.join(keryxConfigDir(dir), CATALOG_CACHE_FILE);
}

function sanitizeBalance(value: unknown): ProviderBalance | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.currency !== "string" || typeof record.total !== "number" || typeof record.exact !== "boolean") {
    return undefined;
  }
  return {
    currency: record.currency,
    total: record.total,
    exact: record.exact,
    ...(typeof record.used === "number" ? { used: record.used } : {}),
    ...(typeof record.remaining === "number" ? { remaining: record.remaining } : {}),
  };
}

/** Accept only the shape this module writes; a hand-edited or stale-shaped entry is dropped rather than trusted. */
function sanitizeEntry(value: unknown): ProviderCatalogEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) return undefined;
  if (typeof record.status !== "string" || !CATALOG_STATUSES.has(record.status)) return undefined;
  if (typeof record.fetchedAt !== "string") return undefined;
  const models = Array.isArray(record.models) ? record.models.filter((m): m is string => typeof m === "string") : [];
  const fallbackModels = Array.isArray(record.fallbackModels)
    ? record.fallbackModels.filter((m): m is string => typeof m === "string")
    : [];
  const balance = sanitizeBalance(record.balance);
  return {
    name: record.name,
    status: record.status as ProviderCatalogStatus,
    models,
    fallbackModels,
    fetchedAt: record.fetchedAt,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(balance !== undefined ? { balance } : {}),
  };
}

/** Read the cache from disk. `undefined` when absent, oversized, unreadable, or not the expected shape — never throws. */
export function loadProviderCatalogCache(dir?: string): ProviderCatalog | undefined {
  const read = readConfigFile(catalogFile(dir));
  if (!read.ok) return undefined;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.fetchedAt !== "string" || typeof record.providers !== "object" || record.providers === null) {
      return undefined;
    }
    const providers: Record<string, ProviderCatalogEntry> = {};
    for (const [key, value] of Object.entries(record.providers as Record<string, unknown>)) {
      const entry = sanitizeEntry(value);
      if (entry !== undefined) providers[key] = entry;
    }
    return { fetchedAt: record.fetchedAt, providers };
  } catch {
    return undefined;
  }
}

function saveCatalogUnlocked(catalog: ProviderCatalog, dir?: string): void {
  ensureKeryxConfigDir(dir);
  writeOwnerOnlyFileAtomic(catalogFile(dir), `${JSON.stringify(catalog, null, 2)}\n`);
}

/** Write the whole catalog (a full refresh). Best-effort — a cache write failure never breaks the caller that just refreshed it. */
export function saveProviderCatalogCache(catalog: ProviderCatalog, dir?: string): void {
  try {
    saveCatalogUnlocked(catalog, dir);
  } catch {
    // Same posture as `version-check.ts`'s `saveCache`: a cache is a courtesy,
    // never a dependency a caller's real result should be blocked on.
  }
}

/** Is `catalog` younger than `ttlMs` (default {@link CATALOG_CACHE_TTL_MS})? `undefined`/an unparseable timestamp is never fresh. */
export function isCatalogFresh(
  catalog: ProviderCatalog | undefined,
  now: () => number = Date.now,
  ttlMs: number = CATALOG_CACHE_TTL_MS,
): boolean {
  if (catalog === undefined) return false;
  const fetchedAtMs = Date.parse(catalog.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return false;
  const age = now() - fetchedAtMs;
  return age >= 0 && age < ttlMs;
}

/**
 * Patch ONE provider's entry into the on-disk cache (AC3: `keryx providers
 * test`/the `[Test]` row button keep the SAME cache current for that one
 * provider, without a full re-refresh of every other one). File-locked
 * against a concurrent full `refreshProviderCatalog` write; best-effort —
 * never throws, a lock/write failure just means the next full refresh
 * eventually overwrites it.
 */
export async function updateProviderCatalogEntry(entry: ProviderCatalogEntry, dir?: string): Promise<void> {
  try {
    await withFileLock(
      `${catalogFile(dir)}.lock`,
      async () => {
        const current = loadProviderCatalogCache(dir) ?? { fetchedAt: entry.fetchedAt, providers: {} };
        const next: ProviderCatalog = {
          fetchedAt: entry.fetchedAt,
          providers: { ...current.providers, [entry.name]: entry },
        };
        saveCatalogUnlocked(next, dir);
      },
      { timeoutMs: CACHE_LOCK_TIMEOUT_MS, retryMs: CACHE_LOCK_RETRY_MS, staleMs: CACHE_LOCK_STALE_MS },
    );
  } catch {
    // Best-effort, like every other write in this module.
  }
}

/**
 * Classify a live `/models` probe result (`ModelsResolveResult`,
 * `../commands/providers`) into one of AC1's catalog statuses. Shared by the
 * refresher (`provider-catalog.ts`) and `providers.ts`'s `providers test` so
 * the two never classify the SAME probe outcome two different ways.
 */
export function classifyModelsStatus(result: ModelsResolveResult): ProviderCatalogStatus {
  if (result.source === "live") return "ok";
  const failure = result.failure;
  if (failure === undefined) return "unreachable";
  switch (failure.kind) {
    case "rejected":
      return "auth-failed";
    case "http":
      return "unreachable";
    case "empty":
      // Reached fine, well-formed, genuinely zero models — not a failure.
      return "ok";
    case "unreachable":
      return failure.detail !== undefined && failure.detail.startsWith("timed out") ? "timeout" : "unreachable";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/** One relative-age phrase for a catalog entry's `fetchedAt` ("just now", "3m ago", "2h ago", "5d ago"). */
export function formatCatalogAge(fetchedAt: string, now: () => number = Date.now): string {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return "unknown age";
  const deltaMs = Math.max(0, now() - fetchedAtMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

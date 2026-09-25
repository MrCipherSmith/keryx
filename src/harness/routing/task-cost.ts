// Flow 341 — real task cost: what a `(provider, model, category)` triple
// ACTUALLY costs per finished task, measured, not assumed from a per-token
// price list. The operator's point motivating this module: a lighter model
// can burn MORE tokens finishing the same task than a stronger one, so
// per-token price alone is not task cost — only a real median cost/tokens
// per completed task tells you that. `derive-default-table.ts`'s cost
// override (`preferByMeasuredCost`) is the one consumer that matters; this
// module owns the record shape, the rolling store, and the pure aggregation
// it reads.
//
// Pure/impure split, mirroring `model-profile.ts`'s own posture: the record
// shape, `recordTaskCost` (append-and-trim) and every `*Stats*` aggregator
// are pure functions over a `TaskCostStore` value — no fs, no clock read
// inside them (a caller passes `recordedAt` in). Only `readTaskCostStore`/
// `writeTaskCostStore`/`appendTaskCostRecord` touch disk, through the same
// `src/lib/config-dir.ts` primitives (`ensureKeryxSubdir`,
// `writeOwnerOnlyFileAtomic`, `readConfigFile`) every other per-user store in
// this codebase uses — 0600, atomic replace, bounded read, degrade to empty
// rather than throw on a missing/oversized/corrupt file.
import path from "node:path";
import { ensureKeryxSubdir, readConfigFile, writeOwnerOnlyFileAtomic } from "../../lib/config-dir";
import { withFileLock } from "../../lib/fs";
import { ROUTING_CATEGORIES, type RoutingCategory } from "./table";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** A bucket a record with no assigned routing category falls into — recorded and shown, never silently dropped. */
export const UNCATEGORIZED = "uncategorized" as const;
export type TaskCostCategory = RoutingCategory | typeof UNCATEGORIZED;

/** One finished task — a `keryx shell` turn today, a subagent run tomorrow. */
export interface TaskCostRecord {
  readonly providerId: string;
  readonly modelId: string;
  /** The routing category the classifier (or the caller) assigned, when one exists. `undefined` records under `UNCATEGORIZED` rather than being dropped. */
  readonly category?: RoutingCategory;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `inputTokens + outputTokens` — stored redundantly (not recomputed by every reader) so a stats consumer never has to re-derive it. */
  readonly totalTokens: number;
  /** USD, when a price is known for both directions (`priceInputPerMillion`/`priceOutputPerMillion`, `./model-profile.ts`) — `undefined` when either is `"unknown"`, never a fabricated number. */
  readonly costUsd?: number;
  readonly success: boolean;
  /** `Date.now()` at the caller — never read from a clock inside this module, so every function here stays pure/testable with an injected value. */
  readonly recordedAt: number;
}

/** One `(provider, model, category)` key's rolling summary. */
export interface TaskCostStats {
  readonly providerId: string;
  readonly modelId: string;
  readonly category: TaskCostCategory;
  readonly n: number;
  readonly medianTokens: number;
  /** `undefined` when no sample in the window carries a known cost. */
  readonly medianCostUsd?: number;
  /** `0..1`. `0` for an empty window (never queried directly — `statsForKey` is only called with `n > 0` samples). */
  readonly successRate: number;
}

/** Looks up a stored stats row for one `(provider, model, category)` triple — the shape `derive-default-table.ts`'s cost override reads, built from an already-loaded store (`taskCostLookupFrom`) so the derivation stays pure. */
export type TaskCostLookup = (providerId: string, modelId: string, category: RoutingCategory) => TaskCostStats | undefined;

/** Keyed by `taskCostKey(providerId, modelId, category)`; each value is the rolling window of the `MAX_SAMPLES_PER_KEY` most recent records for that key, oldest first. */
export type TaskCostStore = Readonly<Record<string, readonly TaskCostRecord[]>>;

export const EMPTY_TASK_COST_STORE: TaskCostStore = {};

/** How many measured tasks a category needs, on BOTH sides of the comparison, before `derive-default-table.ts`'s cost override is allowed to act at all (PRD-level decision, flow 341: below this the sample is too thin to trust). */
export const MIN_MEASURED_TASKS = 20;

/** The rolling window's cap per key — old samples are dropped, not the whole key. Generous enough to span many sessions while keeping the on-disk file small (a few hundred bytes per key at most). */
export const MAX_SAMPLES_PER_KEY = 200;

// ---------------------------------------------------------------------------
// Pure: keying, recording, aggregation
// ---------------------------------------------------------------------------

/** `::`-joined — none of `providerId`/`modelId`/a `RoutingCategory` value ever contains `::` (provider/model ids are URL-safe slugs; categories are the fixed `ROUTING_CATEGORIES` enum), so this never collides. */
export function taskCostKey(providerId: string, modelId: string, category: RoutingCategory | undefined): string {
  return `${providerId}::${modelId}::${category ?? UNCATEGORIZED}`;
}

function parseTaskCostKey(key: string): { providerId: string; modelId: string; category: TaskCostCategory } | undefined {
  const parts = key.split("::");
  if (parts.length !== 3) return undefined;
  const [providerId, modelId, category] = parts as [string, string, string];
  if (providerId.length === 0 || modelId.length === 0) return undefined;
  const validCategory: TaskCostCategory = category === UNCATEGORIZED || (ROUTING_CATEGORIES as readonly string[]).includes(category) ? (category as TaskCostCategory) : UNCATEGORIZED;
  return { providerId, modelId, category: validCategory };
}

/** Append one record to its key's window, trimming to `MAX_SAMPLES_PER_KEY` (oldest dropped first). Pure — returns a NEW store, never mutates `store`. */
export function recordTaskCost(store: TaskCostStore, record: TaskCostRecord): TaskCostStore {
  const key = taskCostKey(record.providerId, record.modelId, record.category);
  const existing = store[key] ?? [];
  const next = existing.length >= MAX_SAMPLES_PER_KEY ? [...existing.slice(existing.length - MAX_SAMPLES_PER_KEY + 1), record] : [...existing, record];
  return { ...store, [key]: next };
}

/** The standard median: average of the two middle values on an even count, exact middle on odd. `0` for an empty array (callers only invoke this on a non-empty window). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Aggregate one key's raw records into its `TaskCostStats`. `records` must be non-empty — callers only call this for a key actually present in the store. */
export function statsForKey(records: readonly TaskCostRecord[], providerId: string, modelId: string, category: TaskCostCategory): TaskCostStats {
  const n = records.length;
  const medianTokens = median(records.map((r) => r.totalTokens));
  const knownCosts = records.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
  const medianCostUsd = knownCosts.length > 0 ? median(knownCosts) : undefined;
  const successRate = records.filter((r) => r.success).length / n;
  return { providerId, modelId, category, n, medianTokens, ...(medianCostUsd !== undefined ? { medianCostUsd } : {}), successRate };
}

/** Every key's stats, sorted by provider then model then category — the deterministic order `keryx routing stats` and its tests rely on. */
export function allStats(store: TaskCostStore): TaskCostStats[] {
  const rows: TaskCostStats[] = [];
  for (const [key, records] of Object.entries(store)) {
    if (records.length === 0) continue;
    const parsed = parseTaskCostKey(key);
    if (parsed === undefined) continue;
    rows.push(statsForKey(records, parsed.providerId, parsed.modelId, parsed.category));
  }
  return rows.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId) || a.category.localeCompare(b.category));
}

/** One key's stats, or `undefined` when nothing is recorded for it yet. */
export function statsFor(store: TaskCostStore, providerId: string, modelId: string, category: RoutingCategory | undefined): TaskCostStats | undefined {
  const key = taskCostKey(providerId, modelId, category);
  const records = store[key];
  if (records === undefined || records.length === 0) return undefined;
  return statsForKey(records, providerId, modelId, category ?? UNCATEGORIZED);
}

/** Builds a `TaskCostLookup` (`derive-default-table.ts`'s parameter) from an already-loaded store — the derivation itself never touches disk. */
export function taskCostLookupFrom(store: TaskCostStore): TaskCostLookup {
  return (providerId, modelId, category) => statsFor(store, providerId, modelId, category);
}

// ---------------------------------------------------------------------------
// Impure: the on-disk store
// ---------------------------------------------------------------------------

const TASK_COST_FILE = "task-cost.json";
const TASK_COST_LOCK_TIMEOUT_MS = 3_000;
const TASK_COST_LOCK_RETRY_MS = 15;
const TASK_COST_LOCK_STALE_MS = 10_000;

/** Absolute path to `task-cost.json`, under a `routing/` subdirectory of the keryx per-user data dir (`ensureKeryxSubdir`, 0700) — same root `model-profiles.json`/`auth.json` live in, kept in its own file (append-heavy, unlike the operator-edited profile store) and its own subdirectory so a future second routing-owned file has an obvious home. */
export function taskCostFilePath(dir?: string): string {
  return path.join(ensureKeryxSubdir(["routing"], dir), TASK_COST_FILE);
}

function isTaskCostRecord(value: unknown): value is TaskCostRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.providerId === "string" &&
    r.providerId.length > 0 &&
    typeof r.modelId === "string" &&
    r.modelId.length > 0 &&
    (r.category === undefined || (ROUTING_CATEGORIES as readonly string[]).includes(r.category as string)) &&
    typeof r.inputTokens === "number" &&
    Number.isFinite(r.inputTokens) &&
    typeof r.outputTokens === "number" &&
    Number.isFinite(r.outputTokens) &&
    typeof r.totalTokens === "number" &&
    Number.isFinite(r.totalTokens) &&
    (r.costUsd === undefined || (typeof r.costUsd === "number" && Number.isFinite(r.costUsd))) &&
    typeof r.success === "boolean" &&
    typeof r.recordedAt === "number" &&
    Number.isFinite(r.recordedAt)
  );
}

/** Read `task-cost.json`. `{}` on any absent/oversized/unreadable/malformed condition — never throws, matching every other reader of this directory (`readConfigFile`'s own contract). A key whose array contains anything that fails `isTaskCostRecord` is dropped wholesale (a partially-corrupt key is not trustworthy evidence for a cost decision). */
export function readTaskCostStore(dir?: string): TaskCostStore {
  const read = readConfigFile(taskCostFilePath(dir));
  if (!read.ok) return EMPTY_TASK_COST_STORE;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY_TASK_COST_STORE;
    const out: Record<string, readonly TaskCostRecord[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value) || !value.every(isTaskCostRecord)) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return EMPTY_TASK_COST_STORE;
  }
}

/** Overwrite `task-cost.json` wholesale, atomically, mode 0600 (`writeOwnerOnlyFileAtomic`). Callers merge first (`appendTaskCostRecord` holds the lock across read+write). */
export function writeTaskCostStore(store: TaskCostStore, dir?: string): void {
  writeOwnerOnlyFileAtomic(taskCostFilePath(dir), `${JSON.stringify(store, null, 2)}\n`);
}

/**
 * Read-modify-write one record onto the on-disk store, under a file lock
 * (same primitive and timeouts `model-profile.ts`'s `withModelProfilesLock`
 * uses) so two turns finishing at nearly the same moment — the interactive
 * shell and a background trigger, say — never clobber each other's append.
 * Never throws: a locking or fs failure is swallowed and the record is
 * simply not persisted, matching every other "best-effort bookkeeping" write
 * in the interactive turn path (`closeSlateOnFlowDone`, the trigger ledger).
 * Returns `true` on a persisted write, `false` on a swallowed failure.
 */
export async function appendTaskCostRecord(record: TaskCostRecord, dir?: string): Promise<boolean> {
  try {
    await withFileLock(
      `${taskCostFilePath(dir)}.lock`,
      async () => {
        const current = readTaskCostStore(dir);
        writeTaskCostStore(recordTaskCost(current, record), dir);
      },
      { timeoutMs: TASK_COST_LOCK_TIMEOUT_MS, retryMs: TASK_COST_LOCK_RETRY_MS, staleMs: TASK_COST_LOCK_STALE_MS },
    );
    return true;
  } catch {
    return false;
  }
}

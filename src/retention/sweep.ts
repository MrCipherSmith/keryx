// Retention sweep engine (flow 237 phase 5, T8 — AC3 / AC-29, the
// retention/prune slice: see `policy.ts` for the full rationale and the
// stores this covers).
//
// Three properties this file exists to hold, all named directly in the task
// this closes:
//   1. A store this cannot even list is reported `"incomplete"` with a
//      reason. It is never folded into a clean `"ok"`, and dry-run vs apply
//      does not change that — an unreadable directory is unreadable either
//      way.
//   2. A single entry that cannot be removed marks its target `"incomplete"`
//      too, but does not stop the rest of the sweep: every other eligible
//      entry in that target, and every other target, still gets a real
//      attempt. One stuck file must cost that one file, not the whole run.
//   3. Dry run is not a simulation layered on top of the real path — it is
//      the same decision logic with `deps.remove` never called. There is
//      exactly one place that decides what is eligible; dry-run and apply
//      only differ in whether the very last step (removal) executes.
//
// What this file does NOT do: it does not claim anything about content
// already relayed to an agent, exported copies, or git history — see
// `RETENTION_SCOPE_NOTE` below, which every report carries rather than
// leaving that scope to be inferred.

import path from "node:path";
import { isNotFound } from "../lib/fs";
import { describeError, type RetentionFsDeps } from "./fs-deps";
import { discoverTargets, type RetentionTarget } from "./policy";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SweepEntryOutcome = "removed" | "would-remove" | "kept" | "remove-failed";
export type SweepEntryReason = "age" | "bytes-cap";

export interface SweepEntryResult {
  name: string;
  path: string;
  bytes: number;
  ageDays: number;
  outcome: SweepEntryOutcome;
  /** Present whenever the entry was (or would be) removed, including a failed attempt. */
  reason?: SweepEntryReason;
  /** Present only when `outcome === "remove-failed"`. */
  error?: string;
}

export type TargetSweepStatus = "ok" | "incomplete" | "empty";

export interface TargetSweepResult {
  id: string;
  label: string;
  dir: string;
  unit: RetentionTarget["unit"];
  status: TargetSweepStatus;
  /** Populated whenever `status !== "ok"` — never left for a reader to infer why. */
  reasons: string[];
  entriesScanned: number;
  /** Entries the policy selected for removal (age past cutoff, or evicted by the byte cap), dry-run or not. */
  entriesEligible: number;
  bytesEligible: number;
  /** Entries actually removed from disk. Always 0 on a dry run. */
  entriesRemoved: number;
  bytesReclaimed: number;
  bytesBefore: number;
  /** `bytesBefore - bytesReclaimed` — the real remaining size on disk right now (dry run: unchanged from `bytesBefore`). */
  bytesRemaining: number;
  entries: SweepEntryResult[];
}

export interface SweepReport {
  generatedAt: string;
  dryRun: boolean;
  status: "ok" | "incomplete";
  targets: TargetSweepResult[];
  /** Discovery-time problems that mean a target may exist that this report
   * never even listed (e.g. `.metaproject/workspaces/` itself unreadable).
   * Kept apart from each target's own `reasons` because these are not about
   * any target in the list below — they are about targets that could not be
   * found in the first place. Always folds `status` to `"incomplete"` when
   * non-empty. */
  discoveryIssues: string[];
  /** AC-29's non-promise, stated rather than left for a reader to assume. */
  scopeNote: string;
}

export const RETENTION_SCOPE_NOTE =
  "Scope: local managed retention stores under .metaproject/ only " +
  "(.metaproject/data/gdctx/raw and artifacts, and .metaproject/workspaces/**/*-write-conflicts/**). " +
  "Content already relayed to an agent, copies exported elsewhere, and git history are out of " +
  "scope for this sweep and are never touched or promised erased by it.";

function buildEntry(
  base: { name: string; path: string; bytes: number; ageDays: number },
  outcome: SweepEntryOutcome,
  extra: { reason?: SweepEntryReason; error?: string } = {},
): SweepEntryResult {
  return {
    ...base,
    outcome,
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

function emptyTargetResult(target: RetentionTarget): TargetSweepResult {
  return {
    id: target.id,
    label: target.label,
    dir: target.dir,
    unit: target.unit,
    status: "empty",
    reasons: [],
    entriesScanned: 0,
    entriesEligible: 0,
    bytesEligible: 0,
    entriesRemoved: 0,
    bytesReclaimed: 0,
    bytesBefore: 0,
    bytesRemaining: 0,
    entries: [],
  };
}

/**
 * Sweep one target: list it, decide what the policy makes eligible (age
 * cutoff, then the byte cap oldest-first over whatever the age cutoff left
 * standing), and — unless `dryRun` — remove exactly those entries.
 *
 * Never throws. Every failure mode this function can hit (an unreadable
 * directory, an unreadable entry, a failed removal) is folded into the
 * returned result's `status`/`reasons` instead.
 */
export async function sweepTarget(
  target: RetentionTarget,
  deps: RetentionFsDeps,
  options: { dryRun: boolean; now?: number },
): Promise<TargetSweepResult> {
  const now = options.now ?? Date.now();

  let names: string[];
  try {
    names = await deps.readdir(target.dir);
  } catch (error) {
    if (isNotFound(error)) return emptyTargetResult(target);
    return {
      ...emptyTargetResult(target),
      status: "incomplete",
      reasons: [`directory unreadable: ${describeError(error)}`],
    };
  }

  type Stated = { name: string; path: string; bytes: number; mtimeMs: number };
  const stated: Stated[] = [];
  const reasons: string[] = [];
  let incomplete = false;

  for (const name of names) {
    const entryPath = path.join(target.dir, name);
    try {
      const info = await deps.statEntry(entryPath, target.unit);
      stated.push({ name, path: entryPath, bytes: info.bytes, mtimeMs: info.mtimeMs });
    } catch (error) {
      incomplete = true;
      reasons.push(`entry unreadable: ${name} (${describeError(error)})`);
    }
  }

  if (stated.length === 0 && names.length === 0) {
    return emptyTargetResult(target);
  }

  // Oldest first throughout — the age cutoff is naturally ordered this way,
  // and the byte-cap eviction below depends on the same order.
  stated.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const ageCutoffMs = now - target.maxAgeDays * DAY_MS;
  const bytesBefore = stated.reduce((sum, entry) => sum + entry.bytes, 0);

  const decisions = new Map<string, SweepEntryReason>();
  for (const entry of stated) {
    if (entry.mtimeMs < ageCutoffMs) decisions.set(entry.path, "age");
  }

  let survivingBytes = stated.filter((entry) => !decisions.has(entry.path)).reduce((sum, entry) => sum + entry.bytes, 0);
  if (survivingBytes > target.maxBytes) {
    for (const entry of stated) {
      if (decisions.has(entry.path)) continue;
      if (survivingBytes <= target.maxBytes) break;
      decisions.set(entry.path, "bytes-cap");
      survivingBytes -= entry.bytes;
    }
  }

  const entries: SweepEntryResult[] = [];
  let entriesEligible = 0;
  let bytesEligible = 0;
  let entriesRemoved = 0;
  let bytesReclaimed = 0;

  for (const entry of stated) {
    const ageDays = Math.floor((now - entry.mtimeMs) / DAY_MS);
    const base = { name: entry.name, path: entry.path, bytes: entry.bytes, ageDays };
    const reason = decisions.get(entry.path);

    if (reason === undefined) {
      entries.push(buildEntry(base, "kept"));
      continue;
    }

    entriesEligible += 1;
    bytesEligible += entry.bytes;

    if (options.dryRun) {
      entries.push(buildEntry(base, "would-remove", { reason }));
      continue;
    }

    try {
      await deps.remove(entry.path, target.unit);
      entries.push(buildEntry(base, "removed", { reason }));
      entriesRemoved += 1;
      bytesReclaimed += entry.bytes;
    } catch (error) {
      if (isNotFound(error)) {
        // Already gone by the time removal ran (e.g. a concurrent sweep) —
        // the goal (this entry no longer exists) is achieved either way.
        entries.push(buildEntry(base, "removed", { reason }));
        entriesRemoved += 1;
        bytesReclaimed += entry.bytes;
        continue;
      }
      incomplete = true;
      const message = describeError(error);
      reasons.push(`could not remove: ${entry.name} (${message})`);
      entries.push(buildEntry(base, "remove-failed", { reason, error: message }));
    }
  }

  return {
    id: target.id,
    label: target.label,
    dir: target.dir,
    unit: target.unit,
    status: incomplete ? "incomplete" : "ok",
    reasons,
    entriesScanned: stated.length,
    entriesEligible,
    bytesEligible,
    entriesRemoved,
    bytesReclaimed,
    bytesBefore,
    bytesRemaining: bytesBefore - bytesReclaimed,
    entries,
  };
}

/** Sweep a fixed list of targets. Pure with respect to discovery — callers
 * that need to find targets on disk first use `sweepProject` below. */
export async function sweepAll(
  targets: readonly RetentionTarget[],
  deps: RetentionFsDeps,
  options: { dryRun: boolean; now?: number },
): Promise<SweepReport> {
  const targetResults: TargetSweepResult[] = [];
  for (const target of targets) {
    targetResults.push(await sweepTarget(target, deps, options));
  }
  const status = targetResults.some((result) => result.status === "incomplete") ? "incomplete" : "ok";
  return {
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    dryRun: options.dryRun,
    status,
    targets: targetResults,
    discoveryIssues: [],
    scopeNote: RETENTION_SCOPE_NOTE,
  };
}

/**
 * The end-to-end entry point the CLI uses: discover targets on disk, then
 * sweep them. Discovery issues (e.g. `.metaproject/workspaces/` itself
 * unreadable) fold the report to `"incomplete"` even when every discovered
 * target swept cleanly — a target that was never found is not the same thing
 * as a target with nothing in it, and the report says so rather than reading
 * as an all-clear.
 */
export async function sweepProject(
  cwd: string,
  deps: RetentionFsDeps,
  options: {
    dryRun: boolean;
    now?: number;
    targetIds?: readonly string[];
    /** Uniformly overrides every discovered target's own cap for this run
     * only — the underlying policy constants in `policy.ts` are untouched. */
    overrides?: { maxAgeDays?: number; maxBytes?: number };
  },
): Promise<SweepReport> {
  const discovery = await discoverTargets(cwd, deps);
  let targets = options.targetIds
    ? discovery.targets.filter((target) => options.targetIds?.includes(target.id))
    : discovery.targets;
  if (options.overrides) {
    const { maxAgeDays, maxBytes } = options.overrides;
    targets = targets.map((target) => ({
      ...target,
      ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    }));
  }
  const report = await sweepAll(targets, deps, options);
  return {
    ...report,
    discoveryIssues: discovery.issues,
    status: discovery.issues.length > 0 ? "incomplete" : report.status,
  };
}

// Flow 404 (AC8): the Part 1 materials are synced once a day by the same serve that fires the digests of flow 389.
//
// This is a daily job, not a stored schedule: it has no time of day, no agent and no spend. A project turns it
// on with `keryx research sync --schedule daily`, which writes ONE small entry file; a running `keryx serve`
// checks the entry, and when the UTC day has not had a sync yet it runs the sync once, in this process, from the
// project's repository root. `--unschedule` removes the entry and the state.
//
// Exactly once per UTC day, across restarts, the way a digest slot is: the day is CLAIMED in
// `.metaproject/data/research-sync/fired.json` before the run starts, so a restarted serve (or a second tick)
// sees the day taken and starts nothing. A day whose run failed is therefore not retried until tomorrow: the
// reason is in `sync-status.md` (the sync writes it) and in serve's notice line (this job reports it). A run that
// fails, or throws, never escapes the tick: serve keeps running.
//
// The entry is only believed when git does not track it (`entryTrusted`, injected): a cloned repository can commit
// its own entry and counts script, and serve must not run what the operator never switched on. Two serve processes
// share the day through an exclusive claim file, and a sync that outlives its deadline is recorded as failed.
//
// It only runs where the Part 1 catalog directory exists (this is keryx's own repository feature); in any other
// project the entry is ignored without a word. The clock, the roots, the sync and the catalog test are all
// injected, so a test drives this with a fake clock and a fake sync and never starts a timer. This file touches
// git in no way and reacts to no event: the only trigger is the tick that serve gives it.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, pathExists, writeFileAtomic } from "../lib/fs";

export function researchSyncDataDir(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "research-sync");
}

export const researchSyncEntryPath = (projectRoot: string): string => path.join(researchSyncDataDir(projectRoot), "schedule.json");
export const researchSyncFiredPath = (projectRoot: string): string => path.join(researchSyncDataDir(projectRoot), "fired.json");
/** One small file per UTC day, created exclusively: the first process to create it owns the day. */
export const researchSyncClaimPath = (projectRoot: string, day: string): string => path.join(researchSyncDataDir(projectRoot), `claim-${day}`);
const CLAIM_PREFIX = "claim-";
/** No sync may hold a tick (or serve's drain) longer than this. */
export const RESEARCH_SYNC_DEADLINE_MS = 5 * 60_000;

export interface ResearchSyncEntry {
  readonly version: 1;
  readonly every: "daily";
  /** ISO time the entry was created. */
  readonly createdAt: string;
}

export interface ResearchSyncFired {
  readonly version: 1;
  /** The UTC day (YYYY-MM-DD) a run was started for. */
  readonly day: string;
  /** ISO time the run was claimed. */
  readonly claimedAt: string;
  /** Set once the run ended: true when the sync succeeded. Absent while it runs, or when the process died in the middle. */
  readonly ok?: boolean;
  /** The one-line reason when `ok` is false. */
  readonly reason?: string;
}

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export async function readResearchSyncEntry(projectRoot: string): Promise<ResearchSyncEntry | undefined> {
  try {
    const raw = JSON.parse(await readFile(researchSyncEntryPath(projectRoot), "utf8")) as Record<string, unknown> | null;
    if (raw !== null && raw["every"] === "daily" && typeof raw["createdAt"] === "string") {
      return { version: 1, every: "daily", createdAt: raw["createdAt"] };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function readResearchSyncFired(projectRoot: string): Promise<ResearchSyncFired | undefined> {
  try {
    const raw = JSON.parse(await readFile(researchSyncFiredPath(projectRoot), "utf8")) as Record<string, unknown> | null;
    if (raw !== null && typeof raw["day"] === "string" && typeof raw["claimedAt"] === "string") {
      return {
        version: 1,
        day: raw["day"],
        claimedAt: raw["claimedAt"],
        ...(typeof raw["ok"] === "boolean" ? { ok: raw["ok"] } : {}),
        ...(typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeFired(projectRoot: string, state: ResearchSyncFired): Promise<void> {
  await writeFileAtomic(researchSyncFiredPath(projectRoot), `${JSON.stringify(state, null, 2)}\n`);
}

/** Make `.metaproject/data/research-sync/` ignore everything in it. Idempotent. */
async function ensureIgnored(projectRoot: string): Promise<void> {
  const dir = researchSyncDataDir(projectRoot);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, ".gitignore");
  try {
    await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeFile(file, "# Daily research sync: the entry and the day it last ran. Never staged.\n*\n!.gitignore\n", "utf8");
  }
}

/** Create the daily entry. Idempotent: an existing entry is kept as it is and `created` is false. */
export async function scheduleResearchSync(projectRoot: string, at: Date = new Date()): Promise<{ created: boolean }> {
  if ((await readResearchSyncEntry(projectRoot)) !== undefined) return { created: false };
  await ensureIgnored(projectRoot);
  const entry: ResearchSyncEntry = { version: 1, every: "daily", createdAt: at.toISOString() };
  await writeFileAtomic(researchSyncEntryPath(projectRoot), `${JSON.stringify(entry, null, 2)}\n`);
  return { created: true };
}

/** Remove the daily entry and the state of its last run. `removed` is false when there was no entry. */
export async function unscheduleResearchSync(projectRoot: string): Promise<{ removed: boolean }> {
  const had = await pathExists(researchSyncEntryPath(projectRoot));
  await rm(researchSyncEntryPath(projectRoot), { force: true });
  await rm(researchSyncFiredPath(projectRoot), { force: true });
  for (const name of await claimFiles(projectRoot)) await rm(path.join(researchSyncDataDir(projectRoot), name), { force: true });
  return { removed: had };
}

async function claimFiles(projectRoot: string): Promise<string[]> {
  try {
    return (await readdir(researchSyncDataDir(projectRoot))).filter((name) => name.startsWith(CLAIM_PREFIX));
  } catch {
    return [];
  }
}

/**
 * Claim the UTC day for this process. `wx` makes the creation exclusive, so of two serve processes that look at the
 * same moment exactly one gets `true`. Claims of earlier days are removed afterwards; they have no further use.
 */
async function claimDay(projectRoot: string, day: string, at: Date): Promise<boolean> {
  try {
    await writeFile(researchSyncClaimPath(projectRoot, day), `${JSON.stringify({ pid: process.pid, claimedAt: at.toISOString() })}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") return false;
    throw error;
  }
  for (const name of await claimFiles(projectRoot)) {
    if (name !== `${CLAIM_PREFIX}${day}`) await rm(path.join(researchSyncDataDir(projectRoot), name), { force: true });
  }
  return true;
}

export type ResearchSyncAction = "ran" | "failed" | "waiting";

export interface ResearchSyncReport {
  readonly root: string;
  readonly action: ResearchSyncAction;
  readonly day: string;
  readonly detail?: string;
}

export interface ResearchSyncJobDeps {
  /** Project roots that may hold the entry (serve passes the working directory and the registered projects). */
  readonly roots: () => readonly string[];
  /** The sync itself, from the repository root. Serve passes `runResearchSync({ root })`. */
  readonly sync: (root: string) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** True when the Part 1 catalog directory exists under `root`; a project without it is skipped without a word. */
  readonly hasCatalog: (root: string) => Promise<boolean>;
  /**
   * True only when the entry file may be believed: it is NOT tracked by git in that project. A cloned repository can
   * commit its own `schedule.json` (and its own counts script), and serve would then run code its owner never opted
   * into; an entry made by `--schedule daily` is untracked. On any doubt the answer is false and the project is skipped.
   */
  readonly entryTrusted: (root: string) => Promise<boolean>;
  /** Longest a single sync may take before it is recorded as failed. Default {@link RESEARCH_SYNC_DEADLINE_MS}. */
  readonly deadlineMs?: number;
  readonly now?: () => Date;
  readonly onNotice?: (message: string) => void;
}

/**
 * One pass over every project: for each one that has the entry and the catalog, run the sync unless the current
 * UTC day already had one. Never throws; a project whose pass went wrong is reported through `onNotice`.
 */
export async function runResearchSyncPass(deps: ResearchSyncJobDeps): Promise<ResearchSyncReport[]> {
  const now = deps.now ?? (() => new Date());
  const reports: ResearchSyncReport[] = [];
  const seen = new Set<string>();
  for (const rootRaw of deps.roots()) {
    const root = path.resolve(rootRaw);
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      const report = await passOne(root, deps, now);
      if (report !== undefined) reports.push(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.onNotice?.(`research sync of ${root} skipped: ${message}`);
    }
  }
  return reports;
}

async function trusted(root: string, deps: ResearchSyncJobDeps): Promise<boolean> {
  try {
    return await deps.entryTrusted(root);
  } catch {
    return false;
  }
}

/** The sync, or a rejection once `ms` have passed. The timer is cleared the moment the sync settles. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sync did not finish within ${Math.max(1, Math.round(ms / 1000))} s`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function passOne(root: string, deps: ResearchSyncJobDeps, now: () => Date): Promise<ResearchSyncReport | undefined> {
  if ((await readResearchSyncEntry(root)) === undefined) return undefined;
  if (!(await deps.hasCatalog(root))) return undefined;
  if (!(await trusted(root, deps))) return undefined;
  const at = now();
  const day = utcDay(at);
  const fired = await readResearchSyncFired(root);
  if (fired?.day === day) return { root, action: "waiting", day };

  // Claim the day BEFORE the run: a second tick, a second serve, or a restarted serve now sees it taken. The claim
  // is an exclusive file creation, so two processes that read `fired.json` at the same moment still start one run.
  if (!(await claimDay(root, day, at))) return { root, action: "waiting", day };
  await writeFired(root, { version: 1, day, claimedAt: at.toISOString() });
  let ok = false;
  let reason: string | undefined;
  try {
    const outcome = await withDeadline(deps.sync(root), deps.deadlineMs ?? RESEARCH_SYNC_DEADLINE_MS);
    ok = outcome.ok;
    reason = outcome.ok ? undefined : (outcome.reason ?? "unknown error");
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (!ok) deps.onNotice?.(`research sync could not run: ${reason ?? "unknown error"}`);
  try {
    await writeFired(root, { version: 1, day, claimedAt: at.toISOString(), ok, ...(reason !== undefined ? { reason } : {}) });
  } catch {
    // The claim is already on disk; the result line is only a convenience.
  }
  return { root, action: ok ? "ran" : "failed", day, ...(reason !== undefined ? { detail: reason } : {}) };
}

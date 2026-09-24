// `keryx learn prune` (W3 spec, "Observation event contract" TTL paragraph +
// CLI surface; plan decisions D4/T8). Two independent maintenance passes,
// neither of which is a hook (spec: "a maintenance pass ... never by the hook
// itself"):
//  - deletes daily observation files more than 30 days past their own date;
//  - expires `status: candidate` records (either scope) whose `ttl.expiresAt`
//    has passed, with no human decision.
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { observationsDir } from "./paths";
import { listPatterns, writePattern, type StoreEnvOptions } from "./store";
import type { LearnedPattern, LearningScope } from "./types";

const OBSERVATION_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const OBSERVATION_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  now?: Date;
  /** Report what would be deleted/expired without writing or removing anything. */
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ExpiredRecord {
  id: string;
  scope: LearningScope;
}

export interface PruneReport {
  /** Observation filenames deleted (or, under `dryRun`, that would be), sorted. */
  deletedObservationFiles: string[];
  /** Candidate records expired (or, under `dryRun`, that would be). */
  expired: ExpiredRecord[];
}

/** The file's own UTC date, from its `YYYY-MM-DD.jsonl` name — or undefined for anything else in the directory (a lockfile, a non-matching name). */
function fileDate(name: string): Date | undefined {
  const match = OBSERVATION_FILE_PATTERN.exec(name);
  if (match === null) return undefined;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

async function pruneObservationFiles(root: string, now: Date, dryRun: boolean): Promise<string[]> {
  const dir = observationsDir(root);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of entries) {
    const date = fileDate(name);
    if (date === undefined) continue;
    const ageDays = (now.getTime() - date.getTime()) / MS_PER_DAY;
    if (ageDays <= OBSERVATION_TTL_DAYS) continue;
    if (!dryRun) await rm(path.join(dir, name), { force: true });
    deleted.push(name);
  }
  return deleted.sort();
}

function withoutTtl(record: LearnedPattern): LearnedPattern {
  const { ttl, ...rest } = record;
  void ttl;
  return rest;
}

async function expireCandidates(root: string, now: Date, dryRun: boolean, storeOptions: StoreEnvOptions): Promise<ExpiredRecord[]> {
  const candidates = await listPatterns(root, { status: "candidate" }, storeOptions);
  const expired: ExpiredRecord[] = [];
  for (const record of candidates) {
    if (record.ttl === undefined) continue;
    if (new Date(record.ttl.expiresAt).getTime() >= now.getTime()) continue;
    if (!dryRun) {
      const updated: LearnedPattern = { ...withoutTtl(record), status: "expired", updatedAt: now.toISOString() };
      await writePattern(root, updated, storeOptions);
    }
    expired.push({ id: record.id, scope: record.scope });
  }
  return expired;
}

/**
 * Runs both maintenance passes. Deleting an observation file and expiring a
 * candidate are independent — a failure in one pass does not skip the other.
 * `writePattern` for `status: "expired"` needs no accept capability (only a
 * transition TO `"accepted"` does), so this never touches `accept-capability.ts`.
 */
export async function pruneLearning(root: string, opts: PruneOptions = {}): Promise<PruneReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const storeOptions: StoreEnvOptions = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };

  const deletedObservationFiles = await pruneObservationFiles(root, now, dryRun);
  const expired = await expireCandidates(root, now, dryRun, storeOptions);

  return { deletedObservationFiles, expired };
}

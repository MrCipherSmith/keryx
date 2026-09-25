// `keryx learn prune` (W3 spec, "Observation event contract" TTL paragraph +
// CLI surface; plan decisions D4/T8). Two independent maintenance passes,
// neither of which is a hook (spec: "a maintenance pass ... never by the hook
// itself"):
//  - deletes daily observation files more than 30 days past their own date;
//  - expires `status: candidate` records (either scope) whose `ttl.expiresAt`
//    has passed, with no human decision.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { removeContained } from "../lib/contained-write";
import { observationsDir } from "./paths";
import { listPatterns, updatePattern, type StoreEnvOptions } from "./store";
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
  /**
   * O-7: one message per failure, from either pass — a failure in one pass
   * (e.g. one file's `rm` fails, or one record's `writePattern` fails) never
   * aborts the rest of that pass or skips the other pass; it is recorded here
   * instead and everything else still runs to completion.
   */
  errors: string[];
}

/** The file's own UTC date, from its `YYYY-MM-DD.jsonl` name — or undefined for anything else in the directory (a lockfile, a non-matching name). */
function fileDate(name: string): Date | undefined {
  const match = OBSERVATION_FILE_PATTERN.exec(name);
  if (match === null) return undefined;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

async function pruneObservationFiles(root: string, now: Date, dryRun: boolean, errors: string[]): Promise<string[]> {
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
    if (!dryRun) {
      try {
        await removeContained(root, path.relative(root, path.join(dir, name)));
      } catch (error) {
        // One file's removal failing must not skip the rest of the directory.
        errors.push(`failed to delete observation file "${name}": ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    deleted.push(name);
  }
  return deleted.sort();
}

function withoutTtl(record: LearnedPattern): LearnedPattern {
  const { ttl, ...rest } = record;
  void ttl;
  return rest;
}

async function expireCandidates(
  root: string,
  now: Date,
  dryRun: boolean,
  storeOptions: StoreEnvOptions,
  errors: string[],
): Promise<ExpiredRecord[]> {
  const candidates = await listPatterns(root, { status: "candidate" }, storeOptions);
  const expired: ExpiredRecord[] = [];
  for (const record of candidates) {
    if (record.ttl === undefined) continue;
    if (new Date(record.ttl.expiresAt).getTime() >= now.getTime()) continue;
    if (!dryRun) {
      try {
        // R1-F1/R1-F7: through the choke point, under the record's own scope
        // lock — re-checks `current.status`/`current.ttl` against what is
        // actually on disk rather than the `record` snapshot listed above.
        await updatePattern(
          root,
          record.id,
          record.scope,
          (current) => {
            if (current.status !== "candidate" || current.ttl === undefined || new Date(current.ttl.expiresAt).getTime() >= now.getTime()) {
              return current;
            }
            return { ...withoutTtl(current), status: "expired", updatedAt: now.toISOString() };
          },
          storeOptions,
        );
      } catch (error) {
        // One record failing to write must not skip the rest of the list.
        errors.push(`failed to expire "${record.id}" (${record.scope}): ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    expired.push({ id: record.id, scope: record.scope });
  }
  return expired;
}

/**
 * The observation-file pass alone (O-7): `runExtract` calls this at the start
 * of every `keryx learn extract` run, so a project's daily observation files
 * are pruned on a normal, human-triggered cadence rather than only by a
 * separate `keryx learn prune` nobody may run — never from a hook (the W3
 * spec: "a maintenance pass ... never by the hook itself"). Never throws:
 * every failure is collected into `errors` instead.
 */
export async function pruneObservationFilesPass(root: string, now: Date = new Date()): Promise<{ deleted: string[]; errors: string[] }> {
  const errors: string[] = [];
  let deleted: string[] = [];
  try {
    deleted = await pruneObservationFiles(root, now, false, errors);
  } catch (error) {
    errors.push(`observation-file prune pass failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { deleted, errors };
}

/**
 * Runs both maintenance passes. Deleting an observation file and expiring a
 * candidate are independent — a failure in one pass does not skip the other
 * (each runs in its own try/catch, O-7), and within a pass one item's failure
 * does not skip its siblings either. `writePattern` for `status: "expired"`
 * needs no accept capability (only a transition TO `"accepted"` does), so
 * this never touches `accept-capability.ts`.
 */
export async function pruneLearning(root: string, opts: PruneOptions = {}): Promise<PruneReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const storeOptions: StoreEnvOptions = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
  const errors: string[] = [];

  let deletedObservationFiles: string[] = [];
  try {
    deletedObservationFiles = await pruneObservationFiles(root, now, dryRun, errors);
  } catch (error) {
    errors.push(`observation-file prune pass failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let expired: ExpiredRecord[] = [];
  try {
    expired = await expireCandidates(root, now, dryRun, storeOptions, errors);
  } catch (error) {
    errors.push(`candidate-expiry prune pass failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { deletedObservationFiles, expired, errors };
}

// Running a leg, and resuming it without paying twice or losing a row.
//
// The pilot's resume rule is "a key is done when BOTH arms are recorded", which is
// right under its failure policy — a task that threw is simply re-run. The arena's
// policy is different and the rule has to follow: a watchdog kill is final, no
// retries, because a retry masks a leg that systematically hangs and quietly
// inflates its score.
//
// Under that policy the pilot's rule breaks in a specific and expensive way. A
// killed arm leaves its pair permanently incomplete, so on every resume the
// SURVIVING arm is run again — paying twice and writing a duplicate row — and,
// worse, `runSweep` filters incomplete pairs out of the mean, so the original
// survivor is dropped from the numbers it was already paid for. Two bugs from one
// missing concept.
//
// So the arena records failures as first-class outcomes in their own file and
// treats a key as settled when each arm has EITHER a result OR a recorded failure.
// A cell that failed stays failed, is reported as failed, and is never silently
// converted into a missing row.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { completionKey } from "../benchmark/retrieval-sweep";
import type { Arm, ArenaArmResult } from "./arena-run";

export interface ArenaFailure {
  readonly taskId: string;
  readonly arm: Arm;
  readonly harness: string;
  readonly reason: string;
  /** A watchdog kill reason when there was one, so failures are separable by cause. */
  readonly killReason?: string;
  readonly at: string;
}

export type ArmOutcome = { readonly kind: "result"; readonly result: ArenaArmResult } | {
  readonly kind: "failure";
  readonly failure: ArenaFailure;
};

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A line torn by an interrupted write is skipped rather than fatal. The cell
      // it belonged to is then simply not settled, and runs again.
    }
  }
  return rows;
}

export function appendJsonl(file: string, row: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
}

export function loadArenaResults(file: string): ArenaArmResult[] {
  return readJsonl<ArenaArmResult>(file);
}

export function loadArenaFailures(file: string): ArenaFailure[] {
  return readJsonl<ArenaFailure>(file);
}

/**
 * Keys whose every arm has an outcome — a result OR a recorded failure.
 *
 * "Settled", not "succeeded". A cell killed by the watchdog is as settled as one
 * that answered, because the policy says it will not be retried. Treating it as
 * unfinished is what makes a resumed sweep re-run the arm that already worked.
 */
export function settledKeys(results: readonly ArenaArmResult[], failures: readonly ArenaFailure[]): Set<string> {
  const arms = new Map<string, Set<Arm>>();
  const note = (harness: string, taskId: string, arm: Arm): void => {
    const key = completionKey(harness, taskId);
    const seen = arms.get(key) ?? new Set<Arm>();
    seen.add(arm);
    arms.set(key, seen);
  };
  for (const result of results) note(result.harness, result.taskId, result.arm);
  for (const failure of failures) note(failure.harness, failure.taskId, failure.arm);

  const settled = new Set<string>();
  for (const [key, seen] of arms) {
    if (seen.has("context-on") && seen.has("context-off")) settled.add(key);
  }
  return settled;
}

/**
 * Rows eligible for a mean: complete pairs of RESULTS only.
 *
 * A pair where one arm failed is settled but not comparable, and including its
 * survivor would compare a context arm against nothing. Dropped from the mean,
 * kept in the report — the distinction the pilot's single rule could not express.
 */
export function comparableRows(results: readonly ArenaArmResult[], failures: readonly ArenaFailure[]): ArenaArmResult[] {
  const failedKeys = new Set(failures.map((failure) => completionKey(failure.harness, failure.taskId)));
  const byKey = new Map<string, ArenaArmResult[]>();
  for (const result of results) {
    const key = completionKey(result.harness, result.taskId);
    if (failedKeys.has(key)) continue;
    const rows = byKey.get(key) ?? [];
    rows.push(result);
    byKey.set(key, rows);
  }
  const comparable: ArenaArmResult[] = [];
  for (const rows of byKey.values()) {
    const arms = new Set(rows.map((row) => row.arm));
    if (arms.has("context-on") && arms.has("context-off")) comparable.push(...rows);
  }
  return comparable;
}

export interface ArenaSweepPaths {
  readonly resultsPath: string;
  readonly failuresPath: string;
}

export interface ArenaSweepProgress {
  (message: string): void;
}

export interface ArenaSweepOptions extends ArenaSweepPaths {
  readonly harness: string;
  readonly tasks: readonly { readonly id: string }[];
  /** Runs both arms of one task, or throws. */
  readonly runTask: (task: { readonly id: string }) => Promise<ArenaArmResult[]>;
  readonly onProgress?: ArenaSweepProgress;
}

export interface ArenaSweepReport {
  readonly harness: string;
  readonly ran: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly ArenaFailure[];
  readonly results: readonly ArenaArmResult[];
}

/**
 * One leg, appending as it goes.
 *
 * Appended per task rather than at the end, for the pilot's reason: an interrupted
 * sweep should cost one task, not the whole leg. A task that throws is recorded as
 * a failure for BOTH arms, because without knowing which arm died the pair cannot
 * be settled arm by arm — and leaving it unsettled is the bug this module exists
 * to close.
 */
export async function runArenaSweep(options: ArenaSweepOptions): Promise<ArenaSweepReport> {
  const say = options.onProgress ?? ((): void => {});
  const previousResults = loadArenaResults(options.resultsPath);
  const previousFailures = loadArenaFailures(options.failuresPath);
  const settled = settledKeys(previousResults, previousFailures);

  const ran: string[] = [];
  const skipped: string[] = [];
  const failed: ArenaFailure[] = [...previousFailures];
  const results: ArenaArmResult[] = [...previousResults];

  for (const task of options.tasks) {
    const key = completionKey(options.harness, task.id);
    if (settled.has(key)) {
      skipped.push(task.id);
      say(`${options.harness} ${task.id}: settled, skipping`);
      continue;
    }
    try {
      const armResults = await options.runTask(task);
      for (const result of armResults) {
        appendJsonl(options.resultsPath, result);
        results.push(result);
      }
      ran.push(task.id);
      say(`${options.harness} ${task.id}: both arms recorded`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const arm of ["context-on", "context-off"] as const) {
        const failure: ArenaFailure = {
          taskId: task.id,
          arm,
          harness: options.harness,
          reason,
          at: new Date().toISOString(),
        };
        appendJsonl(options.failuresPath, failure);
        failed.push(failure);
      }
      say(`${options.harness} ${task.id}: FAILED — ${reason}`);
    }
  }

  return { harness: options.harness, ran, skipped, failed, results };
}

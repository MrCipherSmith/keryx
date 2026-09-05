// The sweep: many tasks, both arms each, results on disk as they land.
//
// Two properties matter more than anything else here.
//
// RESUMABLE. A fifty-task sweep costs real money and takes hours. An
// interruption at task forty must not mean paying for forty tasks again, and
// the temptation to "just restart it and not mention the first attempt" is
// exactly how a sample quietly becomes the runs that happened to finish.
// Results are appended as each task completes, and a resumed sweep skips task
// ids already present.
//
// FIXED MODEL RULE. The pre-registration says runs are split across Opus 5 and
// Sonnet 5 "adaptively by task difficulty", with both arms of a task always on
// the same model, chosen before either runs. Left as prose, "adaptively" is a
// degree of freedom big enough to drive a result through. It is a function here,
// it depends only on the task, and it is written down.

import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runTask, type RunOptions } from "./retrieval-run";
import { decide, type ArmResult, type Verdict } from "./retrieval-scoring";
import type { RetrievalTask } from "./retrieval-tasks";

export const MODEL_HARD = "claude-opus-5";
export const MODEL_EASY = "claude-sonnet-5";

/**
 * Gold-set size is the difficulty signal, and the threshold is three.
 *
 * It is the only difficulty measure available before a run that does not
 * require running: a task whose answer spans four or more files needs the
 * change understood, not just one symptom matched. Anything derived from an
 * arm's behaviour would let the model be chosen by how the arm did, which
 * destroys the comparison.
 *
 * Both arms of a task always get this, so it can favour neither.
 */
export function selectModel(task: RetrievalTask): string {
  return task.gold.length >= 4 ? MODEL_HARD : MODEL_EASY;
}

export interface SweepOptions extends Omit<RunOptions, "modelFor"> {
  readonly tasks: readonly RetrievalTask[];
  /** JSONL, one ArmResult per line. Appended to, never rewritten. */
  readonly resultsPath: string;
  readonly modelFor?: (task: RetrievalTask) => string;
  readonly onProgress?: (message: string) => void;
}

export interface SweepReport {
  readonly verdict: Verdict;
  readonly results: readonly ArmResult[];
  /** Tasks skipped because the results file already had them. */
  readonly resumed: readonly string[];
  /** Tasks that threw, with the reason. Never silently dropped. */
  readonly failed: readonly { taskId: string; reason: string }[];
}

/** Every ArmResult already recorded, so a resumed sweep does not pay twice. */
export async function loadResults(resultsPath: string): Promise<ArmResult[]> {
  if (!existsSync(resultsPath)) return [];
  const text = await readFile(resultsPath, "utf8");
  const results: ArmResult[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      results.push(JSON.parse(line) as ArmResult);
    } catch {
      // A line torn by an interrupted write is skipped rather than fatal; the
      // task it belonged to is then simply re-run.
    }
  }
  return results;
}

/** Task ids with BOTH arms recorded. One arm alone is not a finished task. */
export function completedTaskIds(results: readonly ArmResult[]): Set<string> {
  const arms = new Map<string, Set<string>>();
  for (const result of results) {
    const seen = arms.get(result.taskId) ?? new Set<string>();
    seen.add(result.arm);
    arms.set(result.taskId, seen);
  }
  const done = new Set<string>();
  for (const [taskId, seen] of arms) {
    if (seen.has("context-on") && seen.has("context-off")) done.add(taskId);
  }
  return done;
}

export async function runSweep(options: SweepOptions): Promise<SweepReport> {
  const modelFor = options.modelFor ?? selectModel;
  const say = options.onProgress ?? (() => {});

  const previous = await loadResults(options.resultsPath);
  const done = completedTaskIds(previous);
  // Only complete pairs are kept. A half-recorded task is re-run, and keeping
  // its orphan arm would let it into the mean without a partner.
  const results: ArmResult[] = previous.filter((r) => done.has(r.taskId));
  const resumed = [...done];
  if (resumed.length > 0) say(`resuming: ${resumed.length} task(s) already recorded`);

  const failed: { taskId: string; reason: string }[] = [];

  for (const [index, task] of options.tasks.entries()) {
    if (done.has(task.id)) continue;
    const model = modelFor(task);
    say(`[${index + 1}/${options.tasks.length}] ${task.id} (${model}, ${task.gold.length} gold)`);
    try {
      const armResults = await runTask(task, { ...options, modelFor: () => model });
      for (const result of armResults) {
        // Written before the next task starts, so an interruption costs one
        // task rather than the sweep.
        await appendFile(options.resultsPath, `${JSON.stringify(result)}\n`, "utf8");
        results.push(result);
      }
      const [on, off] = armResults;
      say(
        `    on ${((on?.score.recall ?? 0) * 100).toFixed(0)}% / off ${((off?.score.recall ?? 0) * 100).toFixed(0)}%`,
      );
    } catch (error) {
      // Recorded, not swallowed. A sweep that quietly drops the tasks it choked
      // on reports the subset it could manage as if it were the sample.
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ taskId: task.id, reason });
      say(`    FAILED: ${reason}`);
    }
  }

  return { verdict: decide(results), results, resumed, failed };
}

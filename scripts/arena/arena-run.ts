// One arm, and one task's pair of arms.
//
// The skeleton is the pilot's and is deliberately unchanged in order:
// materialize -> strip or provision -> assert the arm is the arm it claims ->
// prove the answer is unreachable -> inventory -> run the agent -> score ->
// clean up. Every step in that sequence exists because its absence produced a
// number that looked like a result, and the comments in `retrieval-run.ts` record
// which. Four things differ.
//
// **The prompt and the scorer are injected.** The pilot calls one hardwired prompt
// builder and one hardwired scorer from inside `runArm`. The arena has two task
// types whose prompts cannot be shared and whose metrics have nothing in common.
//
// **Arm order alternates.** The pilot always runs `context-on` first, for every
// task, in every leg. Over a multi-hour sweep that confounds the arm with
// everything that drifts: vendor-side model rollouts, rate-limit throttling, the
// page cache of an 8,632-file tree the first arm just warmed, and prompt-cache
// hits that lower the second arm's dollar cost. The control arm was systematically
// second in all of it. Here the order is a deterministic function of
// `(harness, task)` and is recorded in the row.
//
// **Trees come from a per-commit cache.** 78 arms would otherwise mean 78 shallow
// fetches of the same handful of commits.
//
// **Leakage is checked by content as well as by reachability.** A commit being
// absent from the tree says nothing about whether the provisioning step wrote the
// answer into the workspace in prose.

import { rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertAnswerUnreachable } from "../benchmark/retrieval-checkout";
import type { AgentPort } from "../benchmark/retrieval-run";
import { arenaInventory, arenaStripContext, assertArenaArmContext, assertBuildable, type ArenaInventory } from "./arena-context";
import { assertProvisionAncestry, type BaseTreeCache } from "./arena-checkout";
import { buildArenaPrompt } from "./arena-prompts";
import { scorerFor, type ArenaScore } from "./arena-scoring";
import type { ArenaTask } from "./arena-tasks";
import { superviseArm } from "./arena-supervisor";
import type { WatchdogThresholds } from "./arena-watchdog";
import type { SupervisedChild } from "../benchmark/retrieval-supervision";

export type Arm = "context-on" | "context-off";

export interface ArenaArmResult {
  readonly taskId: string;
  readonly taskType: ArenaTask["type"];
  readonly arm: Arm;
  readonly harness: string;
  readonly model: string;
  readonly base: string;
  /** Which arm ran first for this (harness, task). Recorded so the order cannot hide. */
  readonly armOrder: Arm;
  readonly score: ArenaScore;
  readonly toolCalls: number;
  readonly contextTokens: number | null;
  readonly costUsd: number | null;
  readonly stepsToFirstGold: number | null;
  readonly wallClockMs: number;
  readonly inventory: ArenaInventory;
  readonly inventoryAfter: ArenaInventory;
}

export interface ArenaProvisioner {
  provision(treePath: string): Promise<{ provisionCommit: string }>;
  release(treePath: string): Promise<void>;
}

export interface LeakageCheck {
  (treePath: string, needles: readonly string[]): void;
}

export interface ArenaRunOptions {
  readonly repoRoot: string;
  readonly worktreesDir: string;
  readonly agent: AgentPort;
  readonly model: string;
  readonly cache: BaseTreeCache;
  readonly provisioner?: ArenaProvisioner;
  readonly checkLeakage?: LeakageCheck;
  /**
   * Where each arm's raw stream is kept, as `<task>-<harness>-<arm>.jsonl`.
   *
   * The tree is deleted after every arm and the adapters used to discard their
   * streams, so a surprising score could not be explained afterwards. Optional so
   * the tests' fake runs stay free of filesystem side effects.
   */
  readonly transcriptsDir?: string;
  /**
   * Supervise the agent while it runs. Without it the adapter's own timeout is the
   * only bound — a wall clock with no silence detection, which the handoff called
   * tolerable for a six-arm smoke and not for 84 arms.
   */
  readonly watchdog?: {
    readonly thresholds: WatchdogThresholds;
    readonly logFile?: string;
    readonly pollMs?: number;
  };
  /** Gates and diff statistics for an `implement` task. Absent for `research`. */
  readonly evaluateImplementation?: (treePath: string) => Promise<{
    readonly gates: import("./arena-gates").GateVerdict;
    readonly changedSourceFiles: number;
    readonly diffText: string;
  }>;
}

/**
 * Which arm runs first, decided by the task and harness rather than by a clock.
 *
 * Deterministic so a resumed sweep reproduces the same order — a random order
 * would mean a re-run of one cell is not the same cell. Hashing rather than
 * alternating on an index because the index depends on how the task list happened
 * to be sorted, and the order would then correlate with task age.
 */
export function firstArmFor(harness: string, taskId: string): Arm {
  const digest = createHash("sha256")
    // The separator is a NUL, written as an escape rather than as the byte
    // itself. It WAS the byte, which made this file invisible to every text
    // search in the repository: ripgrep skips a file holding one, silently, so
    // a search for anything in here returned nothing and read as "not present".
    // Kept as a NUL rather than changed to a space so the digest — and with it
    // which arm runs first for a given task — is byte-for-byte what it was.
    .update([harness, taskId].join("\u0000"))
    .digest();
  const first = digest[0] ?? 0;
  return first % 2 === 0 ? "context-on" : "context-off";
}

export async function runArenaArm(task: ArenaTask, arm: Arm, options: ArenaRunOptions): Promise<ArenaArmResult> {
  // The harness is in the path because one results file holds several, and two
  // legs sweeping the same task would otherwise check out into, and delete, each
  // other's tree.
  const treePath = path.join(options.worktreesDir, `${task.id}-${options.agent.harness}-${arm}`);
  await options.cache.materialize(task.base, treePath);

  let provisionCommit: string | undefined;
  try {
    if (arm === "context-off") {
      arenaStripContext(treePath);
    } else if (options.provisioner !== undefined) {
      const provisioned = await options.provisioner.provision(treePath);
      provisionCommit = provisioned.provisionCommit;
      // A workspace derived from later code can describe the change the task asks
      // about — the answer, delivered inside the context arm's own workspace.
      assertProvisionAncestry(options.repoRoot, provisionCommit, task.base);
    }

    // Before the agent: an arm that is not the arm it claims to be produces
    // numbers indistinguishable from results.
    assertArenaArmContext(treePath, arm);

    const inventory = arenaInventory(treePath, provisionCommit);
    assertBuildable(inventory, task.type, treePath);

    // Two different leaks. The commit that holds the answer must be unreachable
    // from the tree; and for a task whose answer is a description rather than a
    // diff, the provisioning step must not have written that description into the
    // workspace in prose.
    if (task.answerSha !== undefined) assertAnswerUnreachable(treePath, task.answerSha);
    if (arm === "context-on" && task.answerNeedles.length > 0) {
      options.checkLeakage?.(treePath, task.answerNeedles);
    }

    const prompt = buildArenaPrompt(task);
    const started = Date.now();
    const answer = await options.agent.run({
      cwd: treePath,
      prompt,
      model: options.model,
      gold: task.gold,
      ...(options.transcriptsDir === undefined
        ? {}
        : { transcriptFile: path.join(options.transcriptsDir, `${task.id}-${options.agent.harness}-${arm}.jsonl`) }),
      ...(options.watchdog === undefined
        ? {}
        : {
            supervise: (child: SupervisedChild) =>
              superviseArm(child, {
                thresholds: options.watchdog!.thresholds,
                worktreePath: treePath,
                cell: `${task.id}-${options.agent.harness}-${arm}`,
                ...(options.watchdog!.logFile === undefined ? {} : { logFile: options.watchdog!.logFile }),
                ...(options.watchdog!.pollMs === undefined ? {} : { pollMs: options.watchdog!.pollMs }),
              }),
          }),
    });
    const wallClockMs = Date.now() - started;

    const implementation =
      task.type === "implement" && options.evaluateImplementation !== undefined
        ? await options.evaluateImplementation(treePath)
        : undefined;

    const score = scorerFor(task).score({
      task,
      answerText: answer.text,
      treePath,
      ...(implementation === undefined
        ? {}
        : {
            gates: implementation.gates,
            changedSourceFiles: implementation.changedSourceFiles,
            diffText: implementation.diffText,
          }),
    });

    return {
      taskId: task.id,
      taskType: task.type,
      arm,
      harness: options.agent.harness,
      model: options.model,
      base: task.base,
      armOrder: firstArmFor(options.agent.harness, task.id),
      score,
      toolCalls: answer.toolCalls,
      contextTokens: answer.contextTokens,
      costUsd: answer.costUsd,
      stepsToFirstGold: answer.stepsToFirstGold,
      wallClockMs,
      inventory,
      inventoryAfter: arenaInventory(treePath, provisionCommit),
    };
  } finally {
    if (arm === "context-on" && options.provisioner !== undefined) {
      // Before the tree goes: `keryx init` registers the project user-globally,
      // and 78 throwaway trees would leave 78 dead registry entries pointing at
      // directories that no longer exist. The pilot's registry already carries
      // twenty such leftovers.
      await options.provisioner.release(treePath);
    }
    await rm(treePath, { recursive: true, force: true });
  }
}

/**
 * Both arms of one task, sequentially, in an order neither arm is guaranteed.
 *
 * Sequential for the pilot's reason — two agents at once contend for the same
 * repository and the flakiness would read as variance in the result. Alternating
 * for the arena's: the control arm must not be systematically second.
 */
export async function runArenaTask(task: ArenaTask, options: ArenaRunOptions): Promise<ArenaArmResult[]> {
  const first = firstArmFor(options.agent.harness, task.id);
  const second: Arm = first === "context-on" ? "context-off" : "context-on";
  const firstResult = await runArenaArm(task, first, options);
  const secondResult = await runArenaArm(task, second, options);
  return [firstResult, secondResult];
}

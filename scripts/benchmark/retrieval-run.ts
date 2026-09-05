// Runner for the context-retrieval measurement
// (docs/requirements/keryx-context-measurement/pre-registration.md).
//
// One task, two arms, one difference: whether the worktree still contains the
// project's own context. Everything else — model, prompt, budget, tools, base
// commit — is held identical, because anything else that differs becomes a rival
// explanation for whatever the numbers show.
//
// The agent call is behind a port so the whole pipeline can be exercised without
// spending a cent. A harness whose own wiring can only be tested by paying for
// model calls does not get tested, and this one decides whether a year of work
// was pointed in the right direction.

import { rm } from "node:fs/promises";
import path from "node:path";
import { assertAnswerUnreachable, createIsolatedCheckout } from "./retrieval-checkout";
import { assertArmContext, stripKeryxHooks } from "./retrieval-ablation";
import { extractPaths, scoreRetrieval, type ArmResult } from "./retrieval-scoring";
import type { RetrievalTask } from "./retrieval-tasks";

/** Files that carry the project's own context. `context-off` has these removed. */
export const CONTEXT_PATHS: readonly string[] = [".metaproject", "AGENTS.md", "CLAUDE.md"];

export type Arm = "context-on" | "context-off";

export interface AgentAnswer {
  readonly text: string;
  readonly toolCalls: number;
  /** input + cache_creation + cache_read — see the pre-registration. */
  readonly contextTokens: number;
  readonly costUsd: number;
  /** Tool calls made before the first gold file was named, if ever. */
  readonly stepsToFirstGold: number | null;
}

export interface AgentPort {
  run(input: { cwd: string; prompt: string; model: string; gold: readonly string[] }): Promise<AgentAnswer>;
}

/**
 * Brings the `context-on` worktree up to what a developer at that commit would
 * have had — chiefly the graph, which is generated and never committed.
 *
 * Optional so the wiring tests can run without a keryx binary. Absent, the arm
 * gets whatever git carried, and `assertArmContext` still refuses a tree with no
 * `.metaproject/` at all.
 */
export interface ContextProvisioner {
  provision(worktreePath: string): Promise<void>;
  /** Undo any user-global side effect provisioning had. Best-effort. */
  release(worktreePath: string): Promise<void>;
}

export interface RunOptions {
  readonly repoRoot: string;
  readonly worktreesDir: string;
  readonly agent: AgentPort;
  /** Chosen per task, before either arm runs. Both arms always share it. */
  readonly modelFor: (task: RetrievalTask) => string;
  readonly provisioner?: ContextProvisioner;
}

export function buildPrompt(task: RetrievalTask): string {
  // Deliberately says nothing about how to search. Naming the graph would tell
  // the context-on arm what to do and leave the other guessing, which measures
  // the instruction rather than the context.
  return [
    "A change was made to this repository. From the description below, identify which",
    "source files it changed. Answer with repository-relative paths.",
    "",
    "Description:",
    task.query,
  ].join("\n");
}

/**
 * Remove the project's context from a worktree.
 *
 * Done before the agent starts, never after: an agent that saw `.metaproject/`
 * for one turn has already had the benefit under test.
 */
export async function stripContext(worktreePath: string): Promise<void> {
  for (const entry of CONTEXT_PATHS) {
    await rm(path.join(worktreePath, entry), { recursive: true, force: true });
  }
  // Deleting the files while leaving keryx's hooks registered produced a control
  // arm that was forbidden to grep and redirected to a workspace that no longer
  // existed. See retrieval-ablation.ts.
  await stripKeryxHooks(worktreePath);
}

/**
 * Run one arm and score it.
 *
 * The tree is a standalone shallow checkout at the parent, not a git worktree.
 * A worktree shares the object database and every ref of the repository it came
 * from, which left `git show <the commit being asked about>` returning the
 * answer, and `git log --all --grep` finding that commit from the prompt's own
 * words — the prompt IS the subject line. See retrieval-checkout.ts.
 */
export async function runArm(
  task: RetrievalTask,
  arm: Arm,
  options: RunOptions,
): Promise<ArmResult> {
  const model = options.modelFor(task);
  const treePath = path.join(options.worktreesDir, `${task.id}-${arm}`);
  await createIsolatedCheckout({
    repoRoot: options.repoRoot,
    path: treePath,
    // The parent, never the commit itself. At the commit, the answer is the diff.
    ref: task.parent,
  });
  const created = { path: treePath };
  try {
    if (arm === "context-off") {
      await stripContext(created.path);
    } else if (options.provisioner !== undefined) {
      await options.provisioner.provision(created.path);
    }

    // Before the agent, and before leakage: an arm that is not the arm it claims
    // to be produces numbers that look exactly like results.
    await assertArmContext(created.path, arm, CONTEXT_PATHS);

    // After provisioning, deliberately. The graph is built inside the tree at
    // the parent commit, so it cannot contain files the target PR added — but
    // that is a claim, and this is the check that holds it to account.
    //
    // The check this replaces asserted the gold FILES were absent, which is
    // backwards: they are the search space, not the answer key, and 51 of 60
    // vantage-frontend tasks have all of theirs present at the parent. It also
    // never ran — it read a `leaked` property the result type does not have,
    // and `scripts/` was outside the typecheck.
    assertAnswerUnreachable(created.path, task.sha);

    const answer = await options.agent.run({
      cwd: created.path,
      prompt: buildPrompt(task),
      model,
      gold: task.gold,
    });

    const predicted = extractPaths(answer.text, created.path);
    return {
      taskId: task.id,
      arm,
      model,
      score: scoreRetrieval(predicted, task.gold),
      toolCalls: answer.toolCalls,
      contextTokens: answer.contextTokens,
      costUsd: answer.costUsd,
      stepsToFirstGold: answer.stepsToFirstGold,
    };
  } finally {
    if (arm === "context-on" && options.provisioner !== undefined) {
      // Before the tree goes: `keryx init` registers the project user-globally,
      // and fifty throwaway trees would leave fifty dead registry entries
      // pointing at directories that no longer exist.
      await options.provisioner.release(created.path);
    }
    await rm(treePath, { recursive: true, force: true });
  }
}

/**
 * Both arms of one task, sequentially.
 *
 * Sequential on purpose. Two agents running at once against the same repository
 * contend for `git worktree`'s own lock, and a flaky harness would show up as
 * variance in the result rather than as an error.
 */
export async function runTask(task: RetrievalTask, options: RunOptions): Promise<ArmResult[]> {
  const on = await runArm(task, "context-on", options);
  const off = await runArm(task, "context-off", options);
  return [on, off];
}

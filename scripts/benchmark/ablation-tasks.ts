// Shared task definitions for the M1 ablation runner's per-model producer scripts
// (run-ablation.ts for deepseek-v4-flash, run-ablation-codex.ts for codex CLI). Kept in
// one place so both model legs measure the literal SAME investigation questions — a
// cross-model comparison is only meaningful when the task, not just the answer format,
// is held constant.
//
// Every expectedFile/expectedSymbol pair was verified by reading the source in this
// repository before writing the task — never invented, never guessed.

export type AblationTask = {
  readonly name: string;
  readonly prompt: string;
  readonly expectedFile: string;
  readonly expectedSymbol: string;
};

// AC-5 (specification.md §7): this file is the gold artifact for every ablation task
// below (expectedFile/expectedSymbol IS the answer key) — and it is a real, tracked
// file, so a `git worktree add HEAD` checkout (src/harness/child/git-worktree-port.ts,
// what every ablation producer script uses) includes it. An agent with `read_file`
// could read its own answer key directly. Every ablation producer script strips this
// exact path from every worktree before the agent ever sees it, and verifies that with
// src/metrics/leakage.ts's checkGoldLeakage before trusting a live case.
export const ABLATION_GOLD_ARTIFACT_PATH = "scripts/benchmark/ablation-tasks.ts";

export const ANSWER_FORMAT = "Reply on one line in EXACTLY this format: FILE: <path> SYMBOL: <name>";

export const ABLATION_TASKS: readonly AblationTask[] = [
  {
    name: "wilson-interval",
    prompt:
      `In this repository, which exported function computes the 95% Wilson confidence ` +
      `interval for a rate metric (successes/n)? ${ANSWER_FORMAT}`,
    expectedFile: "src/metrics/benchmark.ts",
    expectedSymbol: "wilsonInterval",
  },
  {
    name: "extract-facts",
    prompt:
      `In this repository, which exported function extracts verifiable facts (file-path ` +
      `tokens and key:value metadata lines) from text for the gdctx fact-preservation ` +
      `oracle? ${ANSWER_FORMAT}`,
    expectedFile: "src/metrics/oracle-runner.ts",
    expectedSymbol: "extractFacts",
  },
  {
    name: "worktree-port",
    prompt:
      `In this repository, which exported TypeScript interface defines the ` +
      `create/remove/merge git-worktree lifecycle used to isolate a parallel mutating ` +
      `subagent? ${ANSWER_FORMAT}`,
    expectedFile: "src/harness/child/worktree.ts",
    expectedSymbol: "WorktreePort",
  },
];

export function checkAblationAnswer(task: AblationTask, finalText: string): boolean {
  const lower = finalText.toLowerCase();
  return lower.includes(task.expectedFile.toLowerCase()) && lower.includes(task.expectedSymbol.toLowerCase());
}

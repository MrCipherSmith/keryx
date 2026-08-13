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

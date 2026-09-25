// flow 332 (AC6) — `/scenarios`: runs `review-jev-scenarios` on the working
// diff and prints the manual-check list + any findings straight into the
// transcript. Same one-shot shape as `/risk` (`jev-risk-command.ts`) and
// flow 330's `/jevrules` (`jev-rules-command.ts`) — see either header for
// why this is deliberately not a modal.

import { computeJevScenariosResult, jevScenariosGateRefusal, type JevScenariosComputedResult } from "../commands/review-jev-scenarios";
import { buildReviewScope } from "../review/scope";

export const JEV_SCENARIOS_COMMAND = "/scenarios";

export function isJevScenariosCommand(name: string): boolean {
  return name === JEV_SCENARIOS_COMMAND;
}

export type GitDiffFn = (cwd: string) => Promise<string>;

async function defaultGitDiff(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "diff", "--no-color", "-U0"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** English, plain-text transcript rendering of the checklist and findings. Pure, so it has its own render test with no shell/process involved. */
export function renderJevScenariosForShell(result: JevScenariosComputedResult): string {
  const lines: string[] = [`review-jev-scenarios: ${result.status}`, result.summary, ""];
  if (result.checklist.length === 0) {
    lines.push("No scenario at or above threshold.");
  } else {
    lines.push("Manual-check list:");
    for (const item of result.checklist) {
      lines.push(`  [${item.kind}] ${item.title} (p=${item.probability.toFixed(2)}) — touched: ${item.touchedLinks.join(", ") || "(none)"}`);
    }
  }
  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of result.findings) {
      lines.push(`  [${finding.severity}] ${finding.file} — ${finding.problem}`);
    }
  }
  return lines.join("\n").trimEnd();
}

/** The whole job of `/scenarios`: the AC5 gate, the working diff, the check, the render. */
export async function runJevScenariosForShell(cwd: string, gitDiff: GitDiffFn = defaultGitDiff): Promise<string> {
  const refusal = await jevScenariosGateRefusal(cwd);
  if (refusal !== undefined) {
    return refusal;
  }
  const diff = await gitDiff(cwd);
  const allChangedFiles = buildReviewScope(diff).files;
  const result = await computeJevScenariosResult({ cwd, allChangedFiles, targetLabel: "working diff" });
  return renderJevScenariosForShell(result);
}

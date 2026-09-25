// flow 332 (AC6) — `/risk`: runs `review-jev-risk` on the working diff and
// prints the ranked risk map + any findings straight into the transcript.
//
// Deliberately NOT a modal, and deliberately its own file — same shape flow
// 330's `jev-rules-command.ts` chose for `/jevrules` (see its own header):
// `io.onSystem?.()`, the one-shot text surface several other single-shot
// commands already use, is enough to satisfy AC6's "show the risk map"; a
// browsable modal is a follow-up, not a requirement this flow's AC asks for.

import { computeJevRiskResult, jevRiskGateRefusal, type JevRiskComputedResult } from "../commands/review-jev-risk";
import { DEFAULT_CONTEXT_LINES, buildReviewScope } from "../review/scope";

export const JEV_RISK_COMMAND = "/risk";

export function isJevRiskCommand(name: string): boolean {
  return name === JEV_RISK_COMMAND;
}

/** `git diff` of the working tree, injectable so a test never shells out. */
export type GitDiffFn = (cwd: string) => Promise<string>;

async function defaultGitDiff(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "diff", "--no-color", `-U${DEFAULT_CONTEXT_LINES}`], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** English, plain-text transcript rendering of the ranked risk map, findings and routing hints. Pure, so it has its own render test with no shell/process involved. */
export function renderJevRiskForShell(result: JevRiskComputedResult): string {
  const lines: string[] = [`review-jev-risk: ${result.status}`, result.summary, ""];
  if (result.ranked.length === 0) {
    lines.push("No hunks scored.");
    return lines.join("\n").trimEnd();
  }
  lines.push("Risk map (ranked, highest first):");
  for (const hunk of result.ranked) {
    lines.push(`  ${hunk.file}:${hunk.startLine}-${hunk.endLine} — combined risk ${hunk.combinedRisk.toFixed(2)} (top: ${hunk.topDimension})`);
  }
  if (result.routingHints.length > 0) {
    lines.push("", "Routing hints:");
    for (const hint of result.routingHints) {
      lines.push(`  ${hint.file}:${hint.startLine}-${hint.endLine} — ${hint.dimension}=${hint.probability.toFixed(2)} -> ${hint.suggestedReviewer}`);
    }
  }
  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of result.findings) {
      lines.push(`  [${finding.severity}] ${finding.file}:${finding.line} — ${finding.problem}`);
    }
  }
  return lines.join("\n").trimEnd();
}

/**
 * The whole job of `/risk`: the AC5 gate, the working diff, the check, the
 * render — one string back, refusal or result, never a throw for an
 * ordinary "not enabled"/"no credential" state.
 */
export async function runJevRiskForShell(cwd: string, gitDiff: GitDiffFn = defaultGitDiff): Promise<string> {
  const refusal = await jevRiskGateRefusal(cwd);
  if (refusal !== undefined) {
    return refusal;
  }
  const diff = await gitDiff(cwd);
  const scope = buildReviewScope(diff);
  const result = await computeJevRiskResult({ cwd, regions: scope.regions, allChangedFiles: scope.files, targetLabel: "working diff" });
  return renderJevRiskForShell(result);
}

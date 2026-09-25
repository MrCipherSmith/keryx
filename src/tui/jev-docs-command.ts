// flow 333 (AC6) — `/staledocs`: runs `review-jev-docs` on the working diff
// and lists stale-doc candidates straight into the transcript.
//
// Deliberately NOT a modal, and its own file rather than a change to
// `conform-inspector.ts`/`conform-source.ts` (flow 326's concurrent
// territory) or `jev-rules-command.ts` (flow 330's) — `io.onSystem?.()`, the
// same one-shot text surface `/jevrules` already uses, is enough to satisfy
// "lists stale-doc candidates for the current branch/PR".

import { computeJevDocsResult, jevDocsGateRefusal, type JevDocsComputedResult } from "../commands/review-jev-docs";
import { hunkRegionsFromDiff } from "../review/conform-state";
import { DEFAULT_CONTEXT_LINES } from "../review/scope";

export const STALEDOCS_COMMAND = "/staledocs";

export function isStaledocsCommand(name: string): boolean {
  return name === STALEDOCS_COMMAND;
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

/** English, plain-text transcript rendering. Pure, so it has its own render test with no shell/process involved. */
export function renderStaledocsForShell(result: JevDocsComputedResult): string {
  const lines: string[] = [`review-jev-docs: ${result.status}`, result.summary, ""];
  if (result.findings.length === 0) {
    lines.push("No stale-doc candidates at or above threshold.");
    return lines.join("\n");
  }
  for (const finding of result.findings) {
    lines.push(`[${finding.severity}] ${finding.file}:${finding.line} — ${finding.problem}`);
    lines.push(`  fix: ${finding.suggested_fix}`);
  }
  return lines.join("\n").trimEnd();
}

/**
 * The whole job of `/staledocs`: the AC5 gate, the working diff, the check,
 * the render — one string back, refusal or result, never a throw for an
 * ordinary "not enabled"/"no credential" state.
 */
export async function runStaledocsForShell(cwd: string, gitDiff: GitDiffFn = defaultGitDiff): Promise<string> {
  const refusal = await jevDocsGateRefusal(cwd);
  if (refusal !== undefined) {
    return refusal;
  }
  const diff = await gitDiff(cwd);
  const regions = hunkRegionsFromDiff(diff);
  const result = await computeJevDocsResult({ cwd, regions, targetLabel: "working diff" });
  return renderStaledocsForShell(result);
}

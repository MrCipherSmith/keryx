// flow 335 — `/contract`: runs `review-jev-contract` on the working diff and
// prints the claim check + any findings straight into the transcript.
//
// Deliberately NOT a modal, and deliberately its own file — same shape flow
// 332's `jev-risk-command.ts` chose for `/risk` (see its own header). The
// working-diff shell command has no PR description to extract claims from
// (there is no `--pr`), so `/contract` checks the working diff against zero
// claims — it still reports the empty claim list, honestly, rather than
// refusing outright; a linked flow's acceptance criteria are a separate
// concern this shell command does not surface (use `keryx review jev-contract
// --pr <n> --flow <id>`, or `/ac`, for that).

import { computeJevContractResult, jevContractGateRefusal, type JevContractComputedResult } from "../commands/review-jev-contract";
import { renderContractMarkdown } from "../review/jev-contract";
import { DEFAULT_CONTEXT_LINES } from "../review/scope";

export const JEV_CONTRACT_COMMAND = "/contract";

export function isJevContractCommand(name: string): boolean {
  return name === JEV_CONTRACT_COMMAND;
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

/** English, plain-text transcript rendering — `renderContractMarkdown` plus the budget line already carried on the result. */
export function renderJevContractForShell(result: JevContractComputedResult): string {
  return renderContractMarkdown(result).trimEnd();
}

/**
 * The whole job of `/contract`: the AC7 gate, the working diff, the check
 * (zero claims — no PR description is available from a working diff), the
 * render — one string back, refusal or result, never a throw for an ordinary
 * "not enabled"/"no credential" state.
 */
export async function runJevContractForShell(cwd: string, gitDiff: GitDiffFn = defaultGitDiff): Promise<string> {
  const refusal = await jevContractGateRefusal(cwd);
  if (refusal !== undefined) {
    return refusal;
  }
  const diffText = await gitDiff(cwd);
  const result = await computeJevContractResult({ cwd, description: "", diffText, targetLabel: "working diff" });
  return renderJevContractForShell(result);
}

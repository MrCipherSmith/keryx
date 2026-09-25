// flow 333 (AC6) — `/opencomments`: runs `review-jev-comments` on the
// current PR and lists open comments with their Jev label straight into the
// transcript.
//
// Deliberately NOT a modal, mirroring `/jevrules`/`/staledocs` — a browsable
// modal is a follow-up, not a requirement this flow's AC asks for.
//
// Unlike `/jevrules`/`/staledocs`, this command needs a `--repo`/`--pr` pair
// (there is no "working diff" analogue for open PR comments), read from the
// shell's own PR-context resolution the same way other PR-scoped commands
// already do — passed in explicitly here rather than re-implemented, so this
// file stays a thin renderer over `computeJevCommentsResult`.

import {
  computeJevCommentsResult,
  createGhJevCommentsFactsPort,
  jevCommentsGateRefusal,
  type JevCommentsComputedResult,
} from "../commands/review-jev-comments";
import { createGhConformPrPort } from "../review/conform-pr-port";

export const OPENCOMMENTS_COMMAND = "/opencomments";

export function isOpencommentsCommand(name: string): boolean {
  return name === OPENCOMMENTS_COMMAND;
}

/** English, plain-text transcript rendering. Pure, so it has its own render test with no shell/process involved. */
export function renderOpencommentsForShell(result: JevCommentsComputedResult): string {
  const lines: string[] = [`review-jev-comments: ${result.status}`, result.summary, ""];
  if (result.findings.length === 0) {
    lines.push(`No still-open or escalation-worthy comments among ${result.openComments} open comment(s).`);
    return lines.join("\n");
  }
  for (const finding of result.findings) {
    lines.push(`[${finding.severity}] ${finding.file ?? "(no file)"}${finding.line !== null ? `:${finding.line}` : ""} — ${finding.problem}`);
    lines.push(`  fix: ${finding.suggested_fix}`);
  }
  return lines.join("\n").trimEnd();
}

/**
 * The whole job of `/opencomments`: the AC5 gate, then the check, then the
 * render — one string back, refusal or result, never a throw for an
 * ordinary "not enabled"/"no credential" state.
 */
export async function runOpencommentsForShell(cwd: string, repo: string, prNumber: number): Promise<string> {
  const refusal = await jevCommentsGateRefusal(cwd);
  if (refusal !== undefined) {
    return refusal;
  }
  const result = await computeJevCommentsResult({
    cwd,
    repo,
    number: prNumber,
    prPort: createGhConformPrPort(undefined, repo),
    factsPort: createGhJevCommentsFactsPort(repo, prNumber),
  });
  return renderOpencommentsForShell(result);
}

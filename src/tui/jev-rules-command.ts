// flow 330 (AC7) — `/jevrules`: runs `review-jev-rules` on the working diff
// and prints its findings, grouped by rule, straight into the transcript.
//
// Deliberately NOT a modal, and deliberately its own file rather than a
// change to `conform-inspector.ts`/`conform-source.ts`: those are flow 326's
// concurrent territory this flow was told not to touch. `io.onSystem?.()` —
// the same one-shot text surface `/bus`'s own error path and several other
// single-shot commands already use — is enough to satisfy "runs it on the
// working diff and lists findings grouped by rule"; a browsable modal is a
// follow-up, not a requirement this flow's AC asks for.

import { computeJevRulesResult, jevRulesGateRefusal, type JevRulesComputedResult } from "../commands/review-jev-rules";
import { hunkRegionsFromDiff } from "../review/conform-state";
import { DEFAULT_CONTEXT_LINES } from "../review/scope";

export const JEV_RULES_COMMAND = "/jevrules";

export function isJevRulesCommand(name: string): boolean {
  return name === JEV_RULES_COMMAND;
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

type Finding = JevRulesComputedResult["findings"][number];

/** Group findings by the ruleId encoded in `dedupe_key` (`<ruleId>::<clauseId>::<file>`, minted once by `synthesizeFindingsFromViolations` and never re-derived). */
export function groupFindingsByRule(findings: readonly Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const ruleId = finding.dedupe_key?.split("::")[0] ?? "(unknown rule)";
    const list = groups.get(ruleId) ?? [];
    list.push(finding);
    groups.set(ruleId, list);
  }
  return groups;
}

/** English, plain-text transcript rendering — grouped by rule (AC7), not by file or by severity. Pure, so it has its own render test with no shell/process involved. */
export function renderJevRulesForShell(result: JevRulesComputedResult): string {
  const lines: string[] = [`review-jev-rules: ${result.status}`, result.summary, ""];
  if (result.findings.length === 0) {
    lines.push("No findings at or above threshold.");
    return lines.join("\n");
  }
  const groups = groupFindingsByRule(result.findings);
  for (const ruleId of [...groups.keys()].sort()) {
    lines.push(`Rule: ${ruleId}`);
    for (const finding of groups.get(ruleId)!) {
      lines.push(`  [${finding.severity}] ${finding.file}:${finding.line} — ${finding.problem}`);
      lines.push(`    fix: ${finding.suggested_fix}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The whole job of `/jevrules`: the AC6 gate, the working diff, the check,
 * the render — one string back, refusal or result, never a throw for an
 * ordinary "not enabled"/"no credential" state (those are messages, not
 * bugs). A real error (a broken `git diff`, a malformed rule doc) still
 * throws, for the caller's catch to report.
 */
export async function runJevRulesForShell(cwd: string, gitDiff: GitDiffFn = defaultGitDiff): Promise<string> {
  const refusal = await jevRulesGateRefusal(cwd);
  if (refusal !== undefined) {
    return refusal;
  }
  const diff = await gitDiff(cwd);
  const regions = hunkRegionsFromDiff(diff);
  const result = await computeJevRulesResult({ cwd, regions, targetLabel: "working diff" });
  return renderJevRulesForShell(result);
}

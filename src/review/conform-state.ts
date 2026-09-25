// Reference-document conformance mode — flow 308, AC3/AC4/AC5 of the frozen
// acceptance criteria: deterministic state gathering for each of the three
// clause kinds, with the deterministic facts computed FIRST and reported as
// evidence — "a lesson from live testing flow 306: Jev given only raw text
// was weak. Deterministic facts computed by keryx and placed in `state`
// above the text are what make its answers useful."
//
// Pure, synchronous, no I/O: every function here takes already-read text
// (PR title/body/diff, report.md, findings.json, a diff) and returns facts +
// the redacted state text to send. Reading the PR/report/diff off disk or
// through `gh` is the ADAPTER's job (`src/commands/review.ts`), exactly the
// split `src/review/ci-triage.ts` already established for CI triage.

import { redactSensitiveText } from "../security/redact";
import { buildReviewScope, type ReviewScope, type ScopeDropReason, type ScopedRegion } from "./scope";
import type { ReferenceClause } from "./conform-clauses";

/** Facts+evidence for one clause, ready to place above the redacted state text (AC5). */
export interface ClauseStateFacts {
  readonly factLines: readonly string[];
  /** Set when a deterministic fact alone decides the clause (AC5) — reported beside Jev's own answer, never in place of it. */
  readonly decisive?: { readonly satisfied: boolean; readonly reason: string };
}

// ---------------------------------------------------------------------------
// AC3: pr-kind state
// ---------------------------------------------------------------------------

export interface PrBodySection {
  readonly heading: string;
  readonly nonEmpty: boolean;
  readonly text: string;
}

/** Split a PR body into its named (`## `/`### `) sections — AC3's "body split into its named sections." */
export function parsePrBodySections(body: string): readonly PrBodySection[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const sections: PrBodySection[] = [];
  let current: { heading: string; textLines: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const text = current.textLines.join("\n").trim();
    sections.push({ heading: current.heading, nonEmpty: text.length > 0, text });
    current = undefined;
  };
  for (const line of lines) {
    const match = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      flush();
      current = { heading: match[1]!, textLines: [] };
      continue;
    }
    if (current !== undefined) current.textLines.push(line);
  }
  flush();
  return sections;
}

export interface PrConformFacts {
  readonly title: string;
  readonly sections: readonly PrBodySection[];
  readonly scope: ReviewScope;
}

/** AC3: gather the pr-kind deterministic facts — sections, and the hand-written size (`buildReviewScope`'s counts, drops excluded). */
export function computePrConformFacts(input: { readonly title: string; readonly body: string; readonly diff: string }): PrConformFacts {
  return {
    title: input.title,
    sections: parsePrBodySections(input.body),
    scope: buildReviewScope(input.diff),
  };
}

const BUDGET_RE = /(\d{2,6})\s*(?:hand[- ]written\s+)?lines?/i;

function describeDropsByReason(scope: ReviewScope): string {
  const entries = Object.entries(scope.counts.droppedByReason).filter(([, count]) => count > 0) as [ScopeDropReason, number][];
  if (entries.length === 0) return "none";
  return entries.map(([reason, count]) => `${reason}: ${count}`).join(", ");
}

/** Per-clause pr-kind facts (AC3/AC5): sections present/absent, and — when the clause states a size budget — a decisive size check. */
export function prClauseFacts(clause: ReferenceClause, facts: PrConformFacts): ClauseStateFacts {
  const present = facts.sections.filter((s) => s.nonEmpty).map((s) => s.heading);
  const absentOrEmpty = facts.sections.filter((s) => !s.nonEmpty).map((s) => s.heading);
  const lines: string[] = [
    `PR body sections present and non-empty: ${present.length > 0 ? present.join(", ") : "(none)"}`,
    `PR body sections named but empty, or absent entirely from this list: ${absentOrEmpty.length > 0 ? absentOrEmpty.join(", ") : "(none)"}`,
    `hand-written changed lines, mechanical bulk excluded (src/review/scope.ts drop reasons): ${facts.scope.counts.changedLinesRetained}`,
    `files retained for review: ${facts.scope.counts.filesRetained}; files dropped as mechanical bulk: ${facts.scope.counts.filesDropped} (${describeDropsByReason(facts.scope)})`,
  ];
  const budgetMatch = BUDGET_RE.exec(clause.text);
  let decisive: ClauseStateFacts["decisive"];
  if (budgetMatch !== undefined && budgetMatch !== null) {
    const budget = Number(budgetMatch[1]);
    const actual = facts.scope.counts.changedLinesRetained;
    const satisfied = actual <= budget;
    lines.push(
      `this clause states a size budget of ${budget} line(s); hand-written changed lines = ${actual} -> ${satisfied ? "within budget" : "OVER budget"}`,
    );
    decisive = {
      satisfied,
      reason: `hand-written changed line count (${actual}) ${satisfied ? "is within" : "exceeds"} the ${budget}-line budget this clause states`,
    };
  }
  return { factLines: lines, ...(decisive !== undefined ? { decisive } : {}) };
}

/** AC3/AC5: the redacted pr-kind state text — title + body, redacted before it ever leaves the machine, bounded. */
export const PR_STATE_BODY_CHARS = 8_000;

export function prRedactedStateText(input: { readonly title: string; readonly body: string }): string {
  const title = redactSensitiveText(input.title);
  const body = redactSensitiveText(input.body);
  const bounded = body.length > PR_STATE_BODY_CHARS ? `${body.slice(0, PR_STATE_BODY_CHARS)}\n… (truncated)` : body;
  return [`PR title: ${title}`, "", "PR body (redacted):", bounded].join("\n");
}

// ---------------------------------------------------------------------------
// AC4: report-kind state
// ---------------------------------------------------------------------------

export type FindingAnchorKind = "file-and-line" | "file-only" | "none";

export interface ReportFindingLike {
  readonly id?: string | undefined;
  readonly severity?: string | undefined;
  readonly evidence?: string | undefined;
  readonly file?: string | null | undefined;
  readonly line?: number | null | undefined;
}

export function classifyFindingAnchor(finding: ReportFindingLike): FindingAnchorKind {
  if (finding.file !== undefined && finding.file !== null && finding.file.length > 0) {
    return finding.line !== undefined && finding.line !== null ? "file-and-line" : "file-only";
  }
  return "none";
}

export interface ReportSection {
  readonly heading: string;
  readonly level: number;
}

/** Every `#`-`######` heading in `report.md`, in document order — AC4's "the report's sections and their order." */
export function parseReportSections(reportMarkdown: string): readonly ReportSection[] {
  const sections: ReportSection[] = [];
  for (const line of reportMarkdown.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match !== null) sections.push({ heading: match[2]!, level: match[1]!.length });
  }
  return sections;
}

export interface ReportConformFacts {
  readonly sections: readonly ReportSection[];
  readonly findingsCount: number;
  readonly findingsMissingSeverity: number;
  readonly findingsMissingEvidence: number;
  readonly anchorCounts: Readonly<Record<FindingAnchorKind, number>>;
}

/** AC4: gather the report-kind deterministic facts from an existing review package's `report.md`/`findings.json`. */
export function computeReportConformFacts(reportMarkdown: string, findings: readonly ReportFindingLike[]): ReportConformFacts {
  const anchorCounts: Record<FindingAnchorKind, number> = { "file-and-line": 0, "file-only": 0, none: 0 };
  let missingSeverity = 0;
  let missingEvidence = 0;
  for (const finding of findings) {
    anchorCounts[classifyFindingAnchor(finding)] += 1;
    if (finding.severity === undefined || finding.severity.length === 0) missingSeverity += 1;
    if (finding.evidence === undefined || finding.evidence.length === 0) missingEvidence += 1;
  }
  return {
    sections: parseReportSections(reportMarkdown),
    findingsCount: findings.length,
    findingsMissingSeverity: missingSeverity,
    findingsMissingEvidence: missingEvidence,
    anchorCounts,
  };
}

/** Per-clause report-kind facts (AC4/AC5). */
export function reportClauseFacts(_clause: ReferenceClause, facts: ReportConformFacts): ClauseStateFacts {
  const order = facts.sections.map((s) => `${"#".repeat(s.level)} ${s.heading}`).join(" -> ") || "(no headings found)";
  const lines: string[] = [
    `report.md section order: ${order}`,
    `findings: ${facts.findingsCount} total`,
    `findings missing a severity: ${facts.findingsMissingSeverity}`,
    `findings missing evidence: ${facts.findingsMissingEvidence}`,
    `finding anchor counts: file+line: ${facts.anchorCounts["file-and-line"]}, file only: ${facts.anchorCounts["file-only"]}, no location (PR/report-level): ${facts.anchorCounts.none}`,
  ];
  let decisive: ClauseStateFacts["decisive"];
  if (facts.findingsCount > 0 && (facts.findingsMissingSeverity > 0 || facts.findingsMissingEvidence > 0)) {
    decisive = {
      satisfied: false,
      reason: `${facts.findingsMissingSeverity} finding(s) have no severity and ${facts.findingsMissingEvidence} have no evidence — every finding must carry both`,
    };
  }
  return { factLines: lines, ...(decisive !== undefined ? { decisive } : {}) };
}

export const REPORT_STATE_MARKDOWN_CHARS = 8_000;

/** AC4/AC5: the redacted report-kind state text — `report.md`, redacted and bounded. */
export function reportRedactedStateText(reportMarkdown: string): string {
  const redacted = redactSensitiveText(reportMarkdown);
  const bounded = redacted.length > REPORT_STATE_MARKDOWN_CHARS ? `${redacted.slice(0, REPORT_STATE_MARKDOWN_CHARS)}\n… (truncated)` : redacted;
  return ["report.md (redacted):", bounded].join("\n");
}

// ---------------------------------------------------------------------------
// AC5: hunk-kind state — `buildReviewScope`'s blocks, unchanged.
// ---------------------------------------------------------------------------

/** AC5: hunk-kind state is exactly `buildReviewScope`'s retained regions — no new extraction. */
export function hunkRegionsFromDiff(diff: string): readonly ScopedRegion[] {
  return buildReviewScope(diff).regions;
}

export function hunkClauseFacts(region: ScopedRegion): ClauseStateFacts {
  return {
    factLines: [
      `hunk: ${region.path}:${region.startLine}-${region.endLine} (${region.changedLines} changed line(s)${region.contextTruncated ? ", context truncated at a file boundary" : ""})`,
    ],
  };
}

export function hunkRedactedStateText(region: ScopedRegion): string {
  return [`hunk ${region.path}:${region.startLine}-${region.endLine} (redacted):`, redactSensitiveText(region.text)].join("\n");
}

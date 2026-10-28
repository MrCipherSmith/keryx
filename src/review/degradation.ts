import { isBlastRadiusScopedFinding } from "./blast-radius";
import {
  REVIEW_EVIDENCE_KINDS,
  type ReviewEvidenceScreen,
  type StructuredReviewFinding,
} from "./types";

/**
 * The ingest screen for `review-degradation` (flow 479).
 *
 * The reviewer's fail-closed rule is enforced here and not in the skill text, for the reason the scope-B
 * screen is: a gate written only as prose does not hold. A `review-degradation` finding of `major` or
 * `blocker` that carries no `evidence_kind` is lowered to `info` and listed in `scope.md`. It is NOT
 * rejected. A true claim should survive, labelled as unproven, and a screen that deletes findings is the
 * failure shape the scope-B record already guards against.
 *
 * Findings of every other reviewer pass through untouched, including those that carry a
 * `degradation_class` or an `evidence_kind` of their own.
 */

/** The reviewer this screen is the business of. Matched by containment on a normalised name. */
export const DEGRADATION_REVIEWER = "review-degradation";

/** The rule name written on the record, the terminal line and the finding's `evidence_screen`. */
export const DEGRADATION_NO_EVIDENCE_RULE = "degradation-no-evidence";

/** Severities the screen holds to the evidence rule. Anything lower is already unproven by its severity. */
const SCREENED_SEVERITIES: readonly string[] = ["blocker", "major"];

export type DegradationDowngrade<T> = {
  /** The finding as it stands after the downgrade. */
  finding: T;
  rule: typeof DEGRADATION_NO_EVIDENCE_RULE;
  from: "blocker" | "major";
  to: "info";
  detail: string;
};

export type DegradationScreenResult<T> = {
  /** Every finding that went in, in order, downgraded ones included. Nothing is dropped. */
  retained: T[];
  downgraded: DegradationDowngrade<T>[];
  /** How many findings were the screen's business (raised by `review-degradation`), whatever happened to them. */
  screened: number;
};

/** The record that reaches `scope.md`, the terminal and the ingest result. */
export type DegradationScreenRecord = {
  screened: number;
  downgraded: Array<{
    id: string;
    reviewer: string;
    from: "blocker" | "major";
    to: "info";
    rule: typeof DEGRADATION_NO_EVIDENCE_RULE;
    detail: string;
  }>;
};

function hasEvidenceKind(finding: Partial<StructuredReviewFinding>): boolean {
  const kind = finding.evidence_kind;
  return typeof kind === "string" && (REVIEW_EVIDENCE_KINDS as readonly string[]).includes(kind);
}

/**
 * Downgrade unproven `major` and `blocker` findings of `review-degradation` to `info`.
 *
 * The downgrade also clears `blocking_merge`: a finding at `info` that still blocked the merge would be
 * the unproven claim holding a gate the evidence rule exists to keep it away from. The severity the
 * reviewer asked for is kept on the finding as `evidence_screen.original_severity`, so the downgrade is
 * visible to every later reader and reversible by a human.
 */
export function screenDegradationFindings<T extends Partial<StructuredReviewFinding>>(
  findings: readonly T[],
): DegradationScreenResult<T> {
  const retained: T[] = [];
  const downgraded: DegradationDowngrade<T>[] = [];
  let screened = 0;
  for (const finding of findings) {
    if (!isBlastRadiusScopedFinding(finding, [DEGRADATION_REVIEWER])) {
      retained.push(finding);
      continue;
    }
    screened += 1;
    const severity = finding.severity;
    if (severity === undefined || !SCREENED_SEVERITIES.includes(severity) || hasEvidenceKind(finding)) {
      retained.push(finding);
      continue;
    }
    const from = severity as "blocker" | "major";
    const marker: ReviewEvidenceScreen = { rule: DEGRADATION_NO_EVIDENCE_RULE, original_severity: from };
    const lowered: T = { ...finding, severity: "info", evidence_screen: marker };
    if (lowered.blocking_merge === true) {
      lowered.blocking_merge = false;
    }
    retained.push(lowered);
    downgraded.push({
      finding: lowered,
      rule: DEGRADATION_NO_EVIDENCE_RULE,
      from,
      to: "info",
      detail: `${from} without evidence_kind (one of ${REVIEW_EVIDENCE_KINDS.join(", ")}) is unproven; kept as info`,
    });
  }
  return { retained, downgraded, screened };
}

export function degradationScreenRecord<T extends Partial<StructuredReviewFinding>>(
  result: DegradationScreenResult<T>,
): DegradationScreenRecord {
  return {
    screened: result.screened,
    downgraded: result.downgraded.map((entry) => ({
      id: entry.finding.id ?? "(no id)",
      reviewer: entry.finding.reviewer ?? "(unknown)",
      from: entry.from,
      to: entry.to,
      rule: entry.rule,
      detail: entry.detail,
    })),
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * `## Degradation evidence screen`: its own heading, written on every ingest, including the one where the
 * reviewer raised nothing. The line `downgraded: 0` next to `screened: N` says the screen ran; an absent
 * block would read the same as a screen that never did.
 */
export function renderDegradationScreenMarkdown(record: DegradationScreenRecord): string {
  const lines: string[] = [
    "## Degradation evidence screen",
    "",
    `rule: ${DEGRADATION_NO_EVIDENCE_RULE}`,
    `screened: ${record.screened}`,
    `downgraded: ${record.downgraded.length}`,
    "",
  ];
  if (record.downgraded.length === 0) {
    lines.push(
      record.screened === 0
        ? "_no `review-degradation` finding in this round._"
        : "_every `major` or `blocker` from `review-degradation` carried an evidence kind._",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| finding | reviewer | rule | from | to | why |");
  lines.push("|---|---|---|---|---|---|");
  for (const entry of record.downgraded) {
    lines.push(
      `| ${escapeCell(entry.id)} | ${escapeCell(entry.reviewer)} | ${entry.rule} | ${entry.from} | ${entry.to} | ${escapeCell(entry.detail)} |`,
    );
  }
  lines.push("");
  lines.push("Downgraded findings are kept, not deleted, and marked unproven: add an evidence kind to restore the severity.");
  lines.push("");
  return lines.join("\n");
}

/**
 * The terminal lines for the same record, one summary line then one per downgrade. Empty when the round had
 * no `review-degradation` finding: the terminal stays quiet for a reviewer that did not run, and scope.md
 * still says the screen ran.
 */
export function renderDegradationScreenLines(record: DegradationScreenRecord): string[] {
  if (record.screened === 0) {
    return [];
  }
  const lines = [`degradation screen: screened=${record.screened} downgraded=${record.downgraded.length}`];
  for (const entry of record.downgraded) {
    lines.push(`  downgraded ${entry.id} ${entry.from} -> ${entry.to} [${entry.rule}]: ${entry.detail}`);
  }
  return lines;
}

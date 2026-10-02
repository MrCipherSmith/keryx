// Flow 392 (AC7): the report. Pure arithmetic over the journal, no model, no
// clock, no randomness: the same records always print the same text.
//
// The match share counts the FIRST answer of each decision. A blind answer that
// the human changed after the reveal is contaminated by the reveal, so the
// change is counted on its own line and never moves the share.

import type { AnswerRecord, DecisionMode, DecisionRecord, OpenRecord, ReasonRecord } from "./types";

export interface Tally {
  /** Answered decisions that had a recommendation. */
  answered: number;
  matched: number;
}

export interface DeviationRow {
  id: string;
  flow: string | null;
  stage: string;
  mode: DecisionMode;
  question: string;
  recommended: string;
  chose: string;
  changed: boolean;
  /** Absent when the human gave no reason, or was never asked. */
  reason?: string;
}

export interface DecisionsReport {
  total: number;
  answered: number;
  unanswered: number;
  withoutRecommendation: number;
  changed: number;
  byMode: Record<DecisionMode, Tally>;
  byStage: Array<{ stage: string; ordinary: Tally; blind: Tally }>;
  deviations: DeviationRow[];
  /** Journal lines that were unreadable or malformed and left out of every number above. */
  skipped: number;
}

function emptyTally(): Tally {
  return { answered: 0, matched: 0 };
}

export function buildReport(records: readonly DecisionRecord[], skipped = 0): DecisionsReport {
  const opens: OpenRecord[] = [];
  const answers = new Map<string, AnswerRecord[]>();
  const reasons = new Map<string, ReasonRecord>();
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind === "open") {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      opens.push(record);
    } else if (record.kind === "answer") {
      const list = answers.get(record.id) ?? [];
      list.push(record);
      answers.set(record.id, list);
    } else if (!reasons.has(record.id)) {
      reasons.set(record.id, record);
    }
  }

  const report: DecisionsReport = {
    total: opens.length,
    answered: 0,
    unanswered: 0,
    withoutRecommendation: 0,
    changed: 0,
    byMode: { ordinary: emptyTally(), blind: emptyTally() },
    byStage: [],
    deviations: [],
    skipped,
  };
  const stages = new Map<string, { ordinary: Tally; blind: Tally }>();

  for (const open of opens) {
    const list = (answers.get(open.id) ?? []).sort((a, b) => a.seq - b.seq);
    const first = list[0];
    if (first === undefined) {
      report.unanswered += 1;
      continue;
    }
    report.answered += 1;
    if (list.length > 1) report.changed += 1;
    if (open.recommendation === null) {
      report.withoutRecommendation += 1;
      continue;
    }
    const matched = first.choice === open.recommendation.optionId;
    const stage = stages.get(open.stage) ?? { ordinary: emptyTally(), blind: emptyTally() };
    stages.set(open.stage, stage);
    for (const tally of [report.byMode[open.mode], stage[open.mode]]) {
      tally.answered += 1;
      if (matched) tally.matched += 1;
    }
    if (!matched) {
      const reason = reasons.get(open.id)?.reason;
      report.deviations.push({
        id: open.id,
        flow: open.flow,
        stage: open.stage,
        mode: open.mode,
        question: open.question,
        recommended: open.recommendation.optionId,
        chose: first.choice,
        changed: list.length > 1,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  }
  report.byStage = [...stages.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([stage, tallies]) => ({ stage, ...tallies }));
  return report;
}

function share(tally: Tally): string {
  if (tally.answered === 0) return "n/a";
  return `${Math.round((tally.matched / tally.answered) * 100)}% (${tally.matched}/${tally.answered})`;
}

export function renderReport(report: DecisionsReport): string {
  const skippedLine = report.skipped > 0 ? `Skipped ${report.skipped} unreadable journal record${report.skipped === 1 ? "" : "s"}.` : undefined;
  if (report.total === 0) return skippedLine === undefined ? "No decisions recorded yet." : `No decisions recorded yet.\n${skippedLine}`;
  const lines = [
    `Decisions: ${report.total} recorded, ${report.answered} answered, ${report.unanswered} not answered yet`,
    `Changed after the reveal: ${report.changed}. Without a recommendation: ${report.withoutRecommendation}.`,
    "",
    "Match with the recommendation, by mode (first answer):",
    `  ordinary  ${share(report.byMode.ordinary)}`,
    `  blind     ${share(report.byMode.blind)}`,
    "",
    "By stage:",
  ];
  if (report.byStage.length === 0) lines.push("  (no answered decision had a recommendation)");
  for (const row of report.byStage) {
    lines.push(`  ${row.stage}: ordinary ${share(row.ordinary)}, blind ${share(row.blind)}`);
  }
  lines.push("", `Deviations: ${report.deviations.length}`);
  for (const dev of report.deviations) {
    const where = dev.flow === null ? "project" : `flow ${dev.flow}`;
    const changed = dev.changed ? ", changed after the reveal" : "";
    lines.push(`  ${dev.id} [${where}, ${dev.stage}, ${dev.mode}${changed}]`);
    lines.push(`    ${dev.question}`);
    lines.push(`    recommended ${dev.recommended}, chose ${dev.chose}`);
    lines.push(`    reason: ${dev.reason ?? "(none given)"}`);
  }
  if (skippedLine !== undefined) lines.push("", skippedLine);
  return lines.join("\n");
}

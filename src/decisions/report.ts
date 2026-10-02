// Flow 392 (AC7): the report. Pure arithmetic over the journal, no model, no
// clock, no randomness: the same records always print the same text.
//
// The match share counts the FIRST answer of each decision. A blind answer that
// the human changed after the reveal is contaminated by the reveal, so the
// change is counted on its own line and never moves the share.

import { oneLine } from "./text";
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
  /** How the flow was found when it was derived: "inferred" is a guess (the one flow in progress). */
  flowSource?: "env" | "branch" | "inferred";
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
  byStage: Array<{ stage: string; ordinary: Tally; blind: Tally; blindRefused: number }>;
  deviations: DeviationRow[];
  /** Questions that looked irreversible (matched the list, carried an action tag, or were flagged by the caller). */
  irreversible: number;
  /** Questions that would have been blind but were asked the ordinary way because they looked irreversible. */
  blindRefused: number;
  /** Decisions whose flow was only inferred (the single in-progress flow), not named by env or branch. */
  inferredFlow: number;
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
    } else {
      // the latest reason wins: the human may change it later (`/decisions reason <why>`)
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
    irreversible: opens.filter((open) => open.irreversible).length,
    blindRefused: opens.filter((open) => open.blindRefused === true).length,
    inferredFlow: opens.filter((open) => open.flow !== null && open.flowSource === "inferred").length,
    skipped,
  };
  const stages = new Map<string, { ordinary: Tally; blind: Tally; blindRefused: number }>();
  const stageOf = (name: string): { ordinary: Tally; blind: Tally; blindRefused: number } => {
    const found = stages.get(name) ?? { ordinary: emptyTally(), blind: emptyTally(), blindRefused: 0 };
    stages.set(name, found);
    return found;
  };

  for (const open of opens) {
    // counted whether or not it was answered: it is about how the question was asked
    if (open.blindRefused === true) stageOf(open.stage).blindRefused += 1;
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
    const stage = stageOf(open.stage);
    for (const tally of [report.byMode[open.mode], stage[open.mode]]) {
      tally.answered += 1;
      if (matched) tally.matched += 1;
    }
    if (!matched) {
      const reason = reasons.get(open.id)?.reason;
      report.deviations.push({
        id: open.id,
        flow: open.flow,
        ...(open.flowSource !== undefined ? { flowSource: open.flowSource } : {}),
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
    const refused = row.blindRefused > 0 ? `, blind refused ${row.blindRefused}` : "";
    lines.push(`  ${oneLine(row.stage)}: ordinary ${share(row.ordinary)}, blind ${share(row.blind)}${refused}`);
  }
  lines.push(
    "",
    `Looked irreversible: ${report.irreversible}. Blind refused because of it: ${report.blindRefused} (a high number on ordinary questions means the irreversible list over-matches).`,
  );
  lines.push("", `Deviations: ${report.deviations.length}`);
  for (const dev of report.deviations) {
    const where = dev.flow === null ? "project" : `flow ${oneLine(dev.flow)}${dev.flowSource === "inferred" ? " (inferred)" : ""}`;
    const changed = dev.changed ? ", changed after the reveal" : "";
    // every free-text field is one capped line here too, whatever an older or hand-edited record holds
    lines.push(`  ${oneLine(dev.id)} [${where}, ${oneLine(dev.stage)}, ${dev.mode}${changed}]`);
    lines.push(`    ${oneLine(dev.question)}`);
    lines.push(`    recommended ${oneLine(dev.recommended)}, chose ${oneLine(dev.chose)}`);
    lines.push(`    reason: ${dev.reason === undefined ? "(none given)" : oneLine(dev.reason)}`);
  }
  if (report.inferredFlow > 0) {
    lines.push("", `Flow attribution inferred (the one flow in progress, not named by KERYX_FLOW or the branch): ${report.inferredFlow} decision${report.inferredFlow === 1 ? "" : "s"}.`);
  }
  if (skippedLine !== undefined) lines.push("", skippedLine);
  return lines.join("\n");
}

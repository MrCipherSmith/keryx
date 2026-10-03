// Flow 392 (AC7): the report. Pure arithmetic over the journal, no model, no
// clock, no randomness: the same records always print the same text.
//
// Backfilled decisions (imported after the fact, see import.ts) are the "before"
// arm of a comparison: they are reported in a block of their own and never counted
// in a live number, and their time to answer (unknown, stored as 0) is never used.
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
  /** Where a backfilled decision came from (e.g. "poll 17"). */
  source?: string;
}

/** The historical decisions imported after the fact, kept apart from the live ones. */
export interface BackfilledReport {
  total: number;
  answered: number;
  withRecommendation: number;
  withoutRecommendation: number;
  /** The tally of the answered decisions that had a recommendation (the first answer). */
  matchTally: Tally;
  /** Share in [0, 1] of matches, or null when no answered decision had a recommendation. */
  matchShare: number | null;
  deviations: DeviationRow[];
}

/** Time to answer of the live decisions only: a backfilled record stores 0 because the time is unknown. */
export interface TimingStats {
  /** Live decisions whose first answer is counted. */
  answered: number;
  medianMs: number | null;
}

export interface DecisionsReport {
  /** Live decisions only; the backfilled ones are counted in `backfilled.total`. */
  total: number;
  answered: number;
  unanswered: number;
  withoutRecommendation: number;
  changed: number;
  byMode: Record<DecisionMode, Tally>;
  byStage: Array<{ stage: string; ordinary: Tally; partial: Tally; blind: Tally; blindRefused: number }>;
  deviations: DeviationRow[];
  /** Questions that looked irreversible (matched the list, carried an action tag, or were flagged by the caller). */
  irreversible: number;
  /** Questions that would have been blind but were asked the ordinary way because they looked irreversible. */
  blindRefused: number;
  /** Decisions whose flow was only inferred (the single in-progress flow), not named by env or branch. */
  inferredFlow: number;
  timing: TimingStats;
  backfilled: BackfilledReport;
  /** Journal lines that were unreadable or malformed and left out of every number above. */
  skipped: number;
}

function emptyTally(): Tally {
  return { answered: 0, matched: 0 };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1] ?? 0;
  const high = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? high : Math.round((low + high) / 2);
}

function buildBackfilled(
  history: readonly OpenRecord[],
  firstAnswer: (id: string) => AnswerRecord | undefined,
  reasons: ReadonlyMap<string, ReasonRecord>,
): BackfilledReport {
  const out: BackfilledReport = {
    total: history.length,
    answered: 0,
    withRecommendation: 0,
    withoutRecommendation: 0,
    matchTally: emptyTally(),
    matchShare: null,
    deviations: [],
  };
  for (const open of history) {
    if (open.recommendation === null) out.withoutRecommendation += 1;
    else out.withRecommendation += 1;
    const first = firstAnswer(open.id);
    if (first === undefined) continue;
    out.answered += 1;
    if (open.recommendation === null) continue;
    out.matchTally.answered += 1;
    if (first.choice === open.recommendation.optionId) {
      out.matchTally.matched += 1;
      continue;
    }
    const reason = reasons.get(open.id)?.reason;
    out.deviations.push({
      id: open.id,
      flow: open.flow,
      stage: open.stage,
      mode: open.mode,
      question: open.question,
      recommended: open.recommendation.optionId,
      chose: first.choice,
      changed: false,
      ...(open.source !== undefined ? { source: open.source } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  out.matchShare = out.matchTally.answered === 0 ? null : out.matchTally.matched / out.matchTally.answered;
  return out;
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

  const live = opens.filter((open) => open.backfilled !== true);
  const history = opens.filter((open) => open.backfilled === true);
  const firstAnswer = (id: string): AnswerRecord | undefined => [...(answers.get(id) ?? [])].sort((a, b) => a.seq - b.seq)[0];

  const report: DecisionsReport = {
    total: live.length,
    answered: 0,
    unanswered: 0,
    withoutRecommendation: 0,
    changed: 0,
    byMode: { ordinary: emptyTally(), partial: emptyTally(), blind: emptyTally() },
    byStage: [],
    deviations: [],
    irreversible: live.filter((open) => open.irreversible).length,
    blindRefused: live.filter((open) => open.blindRefused === true).length,
    inferredFlow: live.filter((open) => open.flow !== null && open.flowSource === "inferred").length,
    timing: { answered: 0, medianMs: null },
    backfilled: buildBackfilled(history, firstAnswer, reasons),
    skipped,
  };
  const stages = new Map<string, { ordinary: Tally; partial: Tally; blind: Tally; blindRefused: number }>();
  const stageOf = (name: string): { ordinary: Tally; partial: Tally; blind: Tally; blindRefused: number } => {
    const found = stages.get(name) ?? { ordinary: emptyTally(), partial: emptyTally(), blind: emptyTally(), blindRefused: 0 };
    stages.set(name, found);
    return found;
  };

  const times: number[] = [];
  for (const open of live) {
    // counted whether or not it was answered: it is about how the question was asked
    if (open.blindRefused === true) stageOf(open.stage).blindRefused += 1;
    const list = (answers.get(open.id) ?? []).sort((a, b) => a.seq - b.seq);
    const first = list[0];
    if (first === undefined) {
      report.unanswered += 1;
      continue;
    }
    report.answered += 1;
    times.push(first.timeToAnswerMs);
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
  report.timing = { answered: times.length, medianMs: median(times) };
  report.byStage = [...stages.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([stage, tallies]) => ({ stage, ...tallies }));
  return report;
}

function share(tally: Tally): string {
  if (tally.answered === 0) return "n/a";
  return `${Math.round((tally.matched / tally.answered) * 100)}% (${tally.matched}/${tally.answered})`;
}

function backfilledShare(report: BackfilledReport): string {
  if (report.matchTally.answered === 0) return "n/a";
  return `${Math.round((report.matchTally.matched / report.matchTally.answered) * 100)}% (${report.matchTally.matched}/${report.matchTally.answered})`;
}

function renderBackfilled(report: BackfilledReport): string[] {
  const lines = [
    "До (историческое, дозаполнено задним числом):",
    `  всего: ${report.total}, с рекомендацией: ${report.withRecommendation}, совпадение: ${backfilledShare(report)}`,
    `  отклонений: ${report.deviations.length}`,
  ];
  for (const dev of report.deviations) {
    const where = [dev.source === undefined ? undefined : oneLine(dev.source), dev.flow === null ? "project" : `flow ${oneLine(dev.flow)}`, oneLine(dev.stage)].filter((part): part is string => part !== undefined);
    lines.push(`  ${oneLine(dev.id)} [${where.join(", ")}]`);
    lines.push(`    ${oneLine(dev.question)}`);
    lines.push(`    рекомендовано ${oneLine(dev.recommended)}, выбрано ${oneLine(dev.chose)}`);
    lines.push(`    причина: ${dev.reason === undefined ? "(не указана)" : oneLine(dev.reason)}`);
  }
  return lines;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderReport(report: DecisionsReport): string {
  const skippedLine = report.skipped > 0 ? `Skipped ${report.skipped} unreadable journal record${report.skipped === 1 ? "" : "s"}.` : undefined;
  if (report.total === 0 && report.backfilled.total === 0) return skippedLine === undefined ? "No decisions recorded yet." : `No decisions recorded yet.\n${skippedLine}`;
  if (report.total === 0) {
    const lines = ["No live decisions recorded yet.", "", ...renderBackfilled(report.backfilled)];
    if (skippedLine !== undefined) lines.push("", skippedLine);
    return lines.join("\n");
  }
  const lines = [
    `Decisions: ${report.total} recorded, ${report.answered} answered, ${report.unanswered} not answered yet`,
    `Changed after the reveal: ${report.changed}. Without a recommendation: ${report.withoutRecommendation}.`,
    ...(report.timing.medianMs === null ? [] : [`Median time to answer: ${seconds(report.timing.medianMs)} (${report.timing.answered} answered).`]),
    "",
    "Match with the recommendation, by mode (first answer):",
    `  ordinary  ${share(report.byMode.ordinary)}`,
    ...(report.byMode.partial.answered > 0 ? [`  partial   ${share(report.byMode.partial)}`] : []),
    `  blind     ${share(report.byMode.blind)}`,
    "",
    "By stage:",
  ];
  if (report.byStage.length === 0) lines.push("  (no answered decision had a recommendation)");
  for (const row of report.byStage) {
    const refused = row.blindRefused > 0 ? `, blind refused ${row.blindRefused}` : "";
    const partial = row.partial.answered > 0 ? `, partial ${share(row.partial)}` : "";
    lines.push(`  ${oneLine(row.stage)}: ordinary ${share(row.ordinary)}${partial}, blind ${share(row.blind)}${refused}`);
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
  if (report.backfilled.total > 0) lines.push("", ...renderBackfilled(report.backfilled));
  if (skippedLine !== undefined) lines.push("", skippedLine);
  return lines.join("\n");
}

function percent(tally: Tally): string {
  if (tally.answered === 0) return "нет данных";
  return `${Math.round((tally.matched / tally.answered) * 100)}% (${tally.matched}/${tally.answered})`;
}

/** One line for the daily topic message, in Russian: live shares by how the question was shown, and the historical share. */
export function renderReportLine(report: DecisionsReport): string {
  const all = report.total + report.backfilled.total;
  return (
    `Журнал решений: всего ${all} (до: ${report.backfilled.total}, после: ${report.total}). ` +
    `Совпадение с рекомендацией: видимая ${percent(report.byMode.ordinary)}, скрытая ${percent(report.byMode.blind)}; ` +
    `до: ${percent(report.backfilled.matchTally)}.`
  );
}

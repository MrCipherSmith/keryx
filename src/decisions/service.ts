// Flow 392: the one door into the recommendation journal. The command layer, the
// TUI and the shells import from here, never from the files behind it (the
// import-zone ratchet counts any other reach as an avoidable bypass).

import { buildReport, renderReport, renderReportLine, type DecisionsReport } from "./report";
import { readJournal } from "./store";

export { journalAsk } from "./ask";
export type { AskAnswer, AskFn, AskOption, AskRequest, JournalAskDeps } from "./ask";
export { BLIND_PROBABILITY, DEFAULT_IRREVERSIBLE, loadDecisionsConfig } from "./blind";
export { answerDecision, openDecision, recordReason } from "./journal";
export { buildReport, renderReport, renderReportLine } from "./report";
export type { AnnotatedRow, BackfilledReport, DecisionsReport, DeviationRow, Tally, TimingStats } from "./report";
export { importBackfill, renderImportResult } from "./import";
export type { ImportResult } from "./import";
export { journalFile, resolveJournalFile } from "./store";
export { resolveFlowContext } from "./context";
export type { FlowContext, FlowSource } from "./context";
export { MAX_OPERATOR_TEXT_LENGTH, MAX_TEXT_LENGTH, oneLine, storedOperatorText } from "./text";
export { changeAnswer, giveReason, latestAnsweredDecision, resolveOptionId } from "./followup";
export type { ChangeAnswerResult, GiveReasonResult } from "./followup";
export type {
  AnswerInput,
  AnswerResult,
  DecisionMode,
  DecisionOption,
  DecisionRecommendation,
  OpenInput,
  OpenResult,
} from "./types";

/** Read the journal and fold it into the report. Never throws: a missing file is an empty report. */
export async function loadReport(cwd: string): Promise<DecisionsReport> {
  const { records, skipped } = await readJournal(cwd);
  return buildReport(records, skipped);
}

/** The report as text, the same lines `keryx decisions report` prints. */
export async function reportText(cwd: string): Promise<string> {
  return renderReport(await loadReport(cwd));
}

/** The report as ONE Russian line, for the daily topic message (`keryx decisions report --line`). */
export async function reportLine(cwd: string): Promise<string> {
  return renderReportLine(await loadReport(cwd));
}

/** How many LIVE decisions the journal holds; the backfilled ones are counted apart by `backfilledCount`. */
export async function decisionCount(cwd: string): Promise<number> {
  return (await loadReport(cwd)).total;
}

/** How many live decisions carry the operator's own text or a typed reason (flow 401). */
export async function annotatedCount(cwd: string): Promise<number> {
  return (await loadReport(cwd)).annotated.length;
}

/** How many backfilled (imported, historical) decisions the journal holds. */
export async function backfilledCount(cwd: string): Promise<number> {
  return (await loadReport(cwd)).backfilled.total;
}

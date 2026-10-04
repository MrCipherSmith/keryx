// Flow 392: the one door into the recommendation journal. The command layer, the
// TUI and the shells import from here, never from the files behind it (the
// import-zone ratchet counts any other reach as an avoidable bypass).

import { buildReport, renderReport, renderReportLine, type DecisionsReport, type ReportOptions } from "./report";
import { readQuality } from "./quality";
import { readJournal } from "./store";

export { CANCEL_ANSWER, journalAsk } from "./ask";
export { DECISION_SOURCES, WORK_DECISION_SOURCES } from "./sources";
export type { DecisionSource } from "./sources";
export type { AskFn, AskOption, AskRequest, JournalAskDeps } from "./ask";
export * from "./arms";
export { BLIND_PROBABILITY, DEFAULT_IRREVERSIBLE, loadDecisionsConfig } from "./blind";
export { answerDecision, openDecision, recordReason } from "./journal";
export { buildReport, renderReport, renderReportLine } from "./report";
export type { ArmRow, BackfilledReport, ChannelReport, ChannelRow, DecisionsReport, DeviationRow, LegacyReport, ReportOptions, Tally, TimingStats } from "./report";
export { effectiveArm, isLegacy, stampLegacy } from "./legacy";
export {
  MODEL_LABEL,
  commandModelCall,
  isQuality,
  rateBlindModel,
  rateDecision,
  readQuality,
  renderQualityMatrix,
} from "./quality";
export type { BlindModelResult, ModelCallFn, ModelCallRequest, ModelCallResult, Quality, QualityMatrix, QualityRecord } from "./quality";
export { buildExport, exportSummaryLine, loadExport, loadExportWithSummary, renderExport } from "./export";
export type { ExportFormat, ExportOptions, ExportRow } from "./export";
export { importBackfill, renderImportResult } from "./import";
export type { ImportResult } from "./import";
export { journalFile, resolveJournalFile } from "./store";
export { resolveFlowContext } from "./context";
export type { FlowContext, FlowSource } from "./context";
export { MAX_TEXT_LENGTH, oneLine } from "./text";
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
export async function loadReport(cwd: string, options: Omit<ReportOptions, "quality"> = {}): Promise<DecisionsReport> {
  const { records, skipped } = await readJournal(cwd);
  return buildReport(records, skipped, { ...options, quality: await readQuality(cwd) });
}

/** The report as text, the same lines `keryx decisions report` prints. */
export async function reportText(cwd: string, options: Omit<ReportOptions, "quality"> = {}): Promise<string> {
  return renderReport(await loadReport(cwd, options));
}

/** The report as ONE Russian line, for the daily topic message (`keryx decisions report --line`). */
export async function reportLine(cwd: string): Promise<string> {
  return renderReportLine(await loadReport(cwd));
}

/** How many LIVE decisions the journal holds; the backfilled ones are counted apart by `backfilledCount`. */
export async function decisionCount(cwd: string): Promise<number> {
  return (await loadReport(cwd)).total;
}

/** How many backfilled (imported, historical) decisions the journal holds. */
export async function backfilledCount(cwd: string): Promise<number> {
  return (await loadReport(cwd)).backfilled.total;
}

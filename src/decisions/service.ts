// Flow 392: the one door into the recommendation journal. The command layer, the
// TUI and the shells import from here, never from the files behind it (the
// import-zone ratchet counts any other reach as an avoidable bypass).

import { buildReport, renderReport, type DecisionsReport } from "./report";
import { readRecords } from "./store";

export { journalAsk } from "./ask";
export type { AskFn, AskOption, AskRequest, JournalAskDeps } from "./ask";
export { BLIND_PROBABILITY, DEFAULT_IRREVERSIBLE, loadDecisionsConfig } from "./blind";
export { answerDecision, openDecision, recordReason } from "./journal";
export { buildReport, renderReport } from "./report";
export type { DecisionsReport, DeviationRow, Tally } from "./report";
export { journalFile } from "./store";
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
  return buildReport(await readRecords(cwd));
}

/** The report as text, the same lines `keryx decisions report` prints. */
export async function reportText(cwd: string): Promise<string> {
  return renderReport(await loadReport(cwd));
}

/** How many decisions the journal holds (the sidebar row shows only when this is above zero). */
export async function decisionCount(cwd: string): Promise<number> {
  return (await loadReport(cwd)).total;
}

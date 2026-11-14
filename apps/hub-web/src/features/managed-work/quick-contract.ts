// The mode table and the template questions are shared with the Hub route and the TUI.
// They are imported from the Hub work module, never copied, so the surfaces cannot drift.
import type { ClarifyAnswer } from "../../../../../src/hub/work/clarify";
import type { QuickModeId } from "../../../../../src/hub/work/quick-modes";
import type { WorkReceipt } from "./types";

export { QUICK_MODES } from "../../../../../src/hub/work/quick-modes";
export type { QuickMode, QuickModeId } from "../../../../../src/hub/work/quick-modes";
export { buildAnswers, questionsFor } from "../../../../../src/hub/work/clarify";
export type { ClarifyAnswer, ClarifyQuestion } from "../../../../../src/hub/work/clarify";

/** The body of POST /quick-start; the operation id travels in the Idempotency-Key header only. */
export type QuickStartRequest = {
  mode: QuickModeId;
  description: string;
  answers: ClarifyAnswer[];
  criteria: string[];
};

export type QuickStartOutcome = {
  receipt: WorkReceipt;
  flowId: string;
  intentId: string;
};

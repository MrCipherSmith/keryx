// Flow 492 T11: the quick-start request as the TUI builds it. Pure on purpose: no OpenTUI, no
// network, no clock. The web dialog sends the same four fields (`QUICK_START_REQUEST_FIELDS`), and
// the parity test (T12) imports this module to prove neither surface drifts from the other.
//
// The mode table and the template questions are the Hub's own (`src/hub/work`): importing them
// here, not copying them, is what keeps the TUI and the web on one set of questions.

import { buildAnswers, type ClarifyAnswer } from "../hub/work/clarify";
import { getMode, type QuickModeId } from "../hub/work/quick-modes";

/** Every key of the request body, in the order the Hub's route reads them. */
export const QUICK_START_REQUEST_FIELDS = ["mode", "description", "answers", "criteria"] as const;

/** The JSON body of the Hub's quick-start route. The operation id travels in the Idempotency-Key header, not here. */
export interface QuickStartRequestBody {
  mode: QuickModeId;
  description: string;
  answers: ClarifyAnswer[];
  criteria: string[];
}

/** What the form holds: answers keyed by template-question id, own criteria as separate sentences. */
export interface QuickStartRequestInput {
  mode: string;
  description: string;
  answers: Readonly<Record<string, string | undefined>>;
  criteria: readonly string[];
}

/** The text of the criteria field as a list: sentences are separated by `;`, blank ones dropped. */
export function parseCriteriaField(text: string): string[] {
  return text
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The request body for one form state. One answer per template question, in template order, with a
 * skipped (blank) question recorded as `{ skipped: true, a: null }`. An unknown mode throws: it is a
 * caller bug, never operator input.
 */
export function buildQuickStartRequest(input: QuickStartRequestInput): QuickStartRequestBody {
  const mode = getMode(input.mode);
  const trimmed: Record<string, string | undefined> = {};
  for (const [id, value] of Object.entries(input.answers)) trimmed[id] = value?.trim();
  return {
    mode: mode.id,
    description: input.description.trim(),
    answers: [...buildAnswers(mode.id, trimmed)],
    criteria: input.criteria.map((text) => text.trim()).filter((text) => text.length > 0),
  };
}

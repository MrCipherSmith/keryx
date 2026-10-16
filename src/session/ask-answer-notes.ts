// Operator answers to ask_user questions, kept as session Notes so the same question is not asked twice
// (after compaction, or in a later turn). The harness writes and reads them; the model never has to, and
// cannot: the `answer.` namespace is reserved (see `isReservedNoteKey` in ./slate), so a model-facing
// `slate_note` can neither forge a stored answer nor delete one.

import { createHash } from "node:crypto";
import { ASK_ANSWER_NOTE_PREFIX, readSlate, writeNote } from "./slate";

export { ASK_ANSWER_NOTE_PREFIX };

const QUESTION_PREVIEW_CHARS = 300;
const ANSWER_MARKER = "\nA: ";
/** The chosen-option prefix the ask_user tool writes; anything else (an own or freeform answer) names no option id. */
const SELECTED_ID = /^User selected id="([^"]*)"/;

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function optionIdSet(optionIds: readonly string[]): string[] {
  return [...new Set(optionIds.map((id) => id.trim()).filter((id) => id.length > 0))].sort();
}

/**
 * `answer.<12 hex>` of the normalized question text AND the sorted option ids, or undefined when the question
 * is empty. The same words with a different set of choices are a different question.
 */
export function askAnswerNoteKey(question: string, optionIds: readonly string[]): string | undefined {
  const normalized = normalizeQuestion(question);
  if (normalized.length === 0) return undefined;
  const ids = optionIdSet(optionIds);
  const hash = createHash("sha256").update(normalized).update("\u0000").update(ids.join("\u0001")).digest("hex");
  return `${ASK_ANSWER_NOTE_PREFIX}${hash.slice(0, 12)}`;
}

/** The option id a stored answer chose, or undefined when it was an own or freeform answer. */
export function storedAnswerOptionId(answer: string): string | undefined {
  return SELECTED_ID.exec(answer)?.[1];
}

/**
 * The operator's stored answer to this exact (normalized) question with these options, if the session slate
 * holds one. A stored pick whose id is not among the current options is dropped, never replayed.
 */
export async function findStoredAnswer(dir: string, question: string, optionIds: readonly string[]): Promise<string | undefined> {
  const key = askAnswerNoteKey(question, optionIds);
  if (key === undefined) return undefined;
  const text = (await readSlate(dir))?.notes?.[key]?.text;
  if (text === undefined) return undefined;
  const at = text.indexOf(ANSWER_MARKER);
  if (at < 0) return undefined;
  const answer = text.slice(at + ANSWER_MARKER.length);
  const chosen = storedAnswerOptionId(answer);
  if (chosen !== undefined && !optionIdSet(optionIds).includes(chosen)) return undefined;
  return answer;
}

/** Store the answer under the question's key. Returns false when nothing was stored. */
export async function rememberAnswer(
  dir: string,
  question: string,
  optionIds: readonly string[],
  answer: string,
  ts: string,
): Promise<boolean> {
  const key = askAnswerNoteKey(question, optionIds);
  if (key === undefined) return false;
  const preview = question.trim().replace(/\s+/g, " ").slice(0, QUESTION_PREVIEW_CHARS);
  const result = await writeNote(dir, key, `Q: ${preview}${ANSWER_MARKER}${answer}`, ts, { harness: true });
  return result.stored !== undefined;
}

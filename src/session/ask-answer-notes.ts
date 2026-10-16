// Operator answers to ask_user questions, kept on the session slate so the same question is not asked twice
// (after compaction, or in a later turn). They live in the slate's harness-only `answers` field, never among the
// model's Notes: no model tool can read, write or delete them, and they do not hold the Notes budget.

import { createHash } from "node:crypto";
import { ASK_ANSWER_NOTE_PREFIX, readSlate, writeAnswer } from "./slate";

export { ASK_ANSWER_NOTE_PREFIX };

/** One offered choice, as far as the key and the replay check read it. */
export interface AnswerOption {
  id: string;
  label: string;
}

const QUESTION_PREVIEW_CHARS = 300;
const ANSWER_MARKER = "\nA: ";
/** The chosen-option prefix the ask_user tool writes; anything else (an own or freeform answer) names no option id. */
const SELECTED_ID = /^User selected id="([^"]*)"/;

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function optionIdSet(options: readonly AnswerOption[]): string[] {
  return [...new Set(options.map((option) => option.id.trim()).filter((id) => id.length > 0))].sort();
}

/** `id` + normalized label of every option, sorted: the choices as the operator saw them. */
function optionSignature(options: readonly AnswerOption[]): string[] {
  return [...new Set(options.map((option) => `${option.id.trim()}\u0002${normalizeText(option.label)}`))].sort();
}

/**
 * `answer.<12 hex>` of the normalized question text AND its options (ids and normalized labels, sorted), or
 * undefined when the question is empty. The same words with different choices, or relabelled choices, are a
 * different question.
 */
export function askAnswerNoteKey(question: string, options: readonly AnswerOption[]): string | undefined {
  const normalized = normalizeText(question);
  if (normalized.length === 0) return undefined;
  const hash = createHash("sha256").update(normalized).update("\u0000").update(optionSignature(options).join("\u0001")).digest("hex");
  return `${ASK_ANSWER_NOTE_PREFIX}${hash.slice(0, 12)}`;
}

/** The (trimmed) option id a stored answer chose, or undefined when it was an own or freeform answer. */
export function storedAnswerOptionId(answer: string): string | undefined {
  return SELECTED_ID.exec(answer)?.[1]?.trim();
}

/**
 * The operator's stored answer to this exact (normalized) question with these options, if the session slate
 * holds one. A stored pick whose id is not among the current options is dropped, never replayed.
 */
export async function findStoredAnswer(dir: string, question: string, options: readonly AnswerOption[]): Promise<string | undefined> {
  const key = askAnswerNoteKey(question, options);
  if (key === undefined) return undefined;
  const stored = (await readSlate(dir))?.answers?.[key];
  if (stored === undefined || stored.source !== "operator") return undefined;
  const at = stored.text.indexOf(ANSWER_MARKER);
  if (at < 0) return undefined;
  const answer = stored.text.slice(at + ANSWER_MARKER.length);
  const chosen = storedAnswerOptionId(answer);
  if (chosen !== undefined && !optionIdSet(options).includes(chosen)) return undefined;
  return answer;
}

/** Store the operator's answer under the question's key. Returns false when nothing was stored. */
export async function rememberAnswer(
  dir: string,
  question: string,
  options: readonly AnswerOption[],
  answer: string,
  ts: string,
): Promise<boolean> {
  const key = askAnswerNoteKey(question, options);
  if (key === undefined) return false;
  const preview = question.trim().replace(/\s+/g, " ").slice(0, QUESTION_PREVIEW_CHARS);
  return (await writeAnswer(dir, key, `Q: ${preview}${ANSWER_MARKER}${answer}`, ts)) !== undefined;
}

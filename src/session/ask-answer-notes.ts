// Operator answers to ask_user questions, kept as session Notes so the same question is not asked twice
// (after compaction, or in a later turn). The harness writes and reads them; the model never has to.

import { createHash } from "node:crypto";
import { readSlate, writeNote } from "./slate";

/** Prefix of every auto-written answer note key. */
export const ASK_ANSWER_NOTE_PREFIX = "answer.";

const QUESTION_PREVIEW_CHARS = 300;
const ANSWER_MARKER = "\nA: ";

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** `answer.<12 hex>` of the normalized question text, or undefined when the question is empty. */
export function askAnswerNoteKey(question: string): string | undefined {
  const normalized = normalizeQuestion(question);
  if (normalized.length === 0) return undefined;
  return `${ASK_ANSWER_NOTE_PREFIX}${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

/** The operator's stored answer to this exact (normalized) question, if the session slate holds one. */
export async function findStoredAnswer(dir: string, question: string): Promise<string | undefined> {
  const key = askAnswerNoteKey(question);
  if (key === undefined) return undefined;
  const text = (await readSlate(dir))?.notes?.[key]?.text;
  if (text === undefined) return undefined;
  const at = text.indexOf(ANSWER_MARKER);
  return at < 0 ? undefined : text.slice(at + ANSWER_MARKER.length);
}

/** Store the answer under the question's key. Returns false when nothing was stored. */
export async function rememberAnswer(dir: string, question: string, answer: string, ts: string): Promise<boolean> {
  const key = askAnswerNoteKey(question);
  if (key === undefined) return false;
  const preview = question.trim().replace(/\s+/g, " ").slice(0, QUESTION_PREVIEW_CHARS);
  const result = await writeNote(dir, key, `Q: ${preview}${ANSWER_MARKER}${answer}`, ts);
  return result.stored !== undefined;
}

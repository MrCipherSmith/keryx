// Flow 392: free text from the human or the agent that ends up on ONE line of
// journal.md or of the report. A newline inside it would start a line of its own
// (a forged journal entry, a forged report row), so whitespace and control
// characters of every kind are collapsed to single spaces and the length is capped.
// Applied when a record is written and again when it is rendered, so a record
// written by an older version (or edited by hand) cannot inject lines either.

import { redactSensitiveText } from "../security/service";
import { maskSecretRuns } from "../security/secret-shape";

export const MAX_TEXT_LENGTH = 300;

/** Flow 401: the operator's own answer and the reason they give are kept up to this many characters. */
export const MAX_OPERATOR_TEXT_LENGTH = 2000;

export function oneLine(text: string, max: number = MAX_TEXT_LENGTH): string {
  const flat = text.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Flow 401: what the operator typed (an own answer, a reason) as it is stored. The one place
 * it enters the journal, so every reader (journal.jsonl, journal.md, the report, the modal) sees
 * the same text. Three steps, in this order:
 *   1. redacted: the shared redactor, then the guard for the shapes it misses (a Telegram bot token,
 *      a bare base64url run), so a pasted credential never reaches a file;
 *   2. flattened to one line, so a newline cannot forge a journal.md or report row;
 *   3. kept in full up to {@link MAX_OPERATOR_TEXT_LENGTH}; a longer text is cut with a visible
 *      marker that says how much was left out, never silently.
 * Redaction runs before the cut so a secret is never shortened into something nothing recognises.
 */
export function storedOperatorText(text: string, max: number = MAX_OPERATOR_TEXT_LENGTH): string {
  const masked = maskSecretRuns(redactSensitiveText(text), "[REDACTED:secret]");
  const flat = masked.replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (flat.length <= max) return flat;
  let end = max;
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // never cut a surrogate pair in half
  return `${flat.slice(0, end).trimEnd()} … [truncated: ${flat.length - end} more characters]`;
}

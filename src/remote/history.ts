// What the topic gets back when it asks for the session's history (flow 399).
//
// A topic is deleted when the shell exits, and a resumed session gets a new, empty one. The
// operator wants the last few messages of the conversation there again: what they wrote and
// what the agent answered. Pure functions only; the bridge does the sending.
//
// What counts as a message:
//   - an operator turn (`isOperatorMessage`: a typed line, never an injected anchors block, a
//     compaction summary or a harness nudge);
//   - the FINAL assistant text of a turn. The text of a round that went on to call tools is
//     narration ("let me look") and is dropped, exactly as a live Telegram reply drops it.
// Tool calls, tool output and reasoning are never part of it.

import type { NormalizedMessage } from "../harness/provider/types";
import { isOperatorMessage } from "../session/compact";
import { redactSensitiveText } from "../security/service";

/** How many messages `/history` posts when no number is given, and the automatic restore posts. */
export const HISTORY_DEFAULT_COUNT = 10;
/** The most `/history N` accepts. */
export const HISTORY_MAX_COUNT = 20;
/** A restored message longer than this is cut, with a marker. */
export const HISTORY_ITEM_MAX_CHARS = 1_500;

export const HISTORY_USAGE = `Usage: /history [N]  (N is a number from 1 to ${HISTORY_MAX_COUNT}; no number means ${HISTORY_DEFAULT_COUNT})`;

/** The one line `/history` answers with when the session has nothing to restore. */
export const HISTORY_EMPTY_MESSAGE = "There is no history to post yet: this session has no messages.";

export type HistoryRole = "user" | "agent";

export interface HistoryItem {
  role: HistoryRole;
  text: string;
}

export type HistoryArgs = { ok: true; count: number } | { ok: false; message: string };

/** `/history`, `/history 5`. Anything but one whole number from 1 to 20 is a usage error. Pure. */
export function parseHistoryArgs(args: string): HistoryArgs {
  const words = args.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return { ok: true, count: HISTORY_DEFAULT_COUNT };
  if (words.length > 1) return { ok: false, message: HISTORY_USAGE };
  const word = words[0] as string;
  if (!/^\d{1,3}$/.test(word)) return { ok: false, message: HISTORY_USAGE };
  const count = Number(word);
  if (count < 1 || count > HISTORY_MAX_COUNT) return { ok: false, message: HISTORY_USAGE };
  return { ok: true, count };
}

/**
 * The messages of `history` that qualify, oldest first. Pure.
 *
 * Walks the session once: an operator turn closes the turn before it (its pending final text
 * becomes an agent item) and is itself an item; an assistant message that emitted tool calls
 * discards the text gathered so far in this turn; a later assistant message without calls
 * replaces it. A turn that ended on tool calls with no closing text yields no agent item.
 */
export function qualifyingHistory(
  history: readonly NormalizedMessage[],
  options: { turnRunning?: boolean } = {},
): HistoryItem[] {
  const items: HistoryItem[] = [];
  let pending: string | undefined;
  const flush = (): void => {
    if (pending !== undefined) items.push({ role: "agent", text: pending });
    pending = undefined;
  };
  for (const message of history) {
    if (message.role === "assistant") {
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        pending = undefined;
      } else if (message.content.trim().length > 0) {
        pending = message.content;
      }
      continue;
    }
    if (isOperatorMessage(message) && message.content.trim().length > 0) {
      flush();
      items.push({ role: "user", text: message.content });
    }
  }
  // While a turn is running its assistant message is still being written: the streaming loop
  // appends to that very object, so what is there now is half a sentence. Only a finished turn's
  // text counts; the one in flight appears once it ends.
  if (options.turnRunning !== true) flush();
  return items;
}

/** The last `count` qualifying messages, oldest first. Pure. Strings, so a later edit of the live history changes nothing here. */
export function selectHistory(
  history: readonly NormalizedMessage[],
  count: number,
  options: { turnRunning?: boolean } = {},
): HistoryItem[] {
  const items = qualifyingHistory(history, options);
  return count >= items.length ? items : items.slice(items.length - Math.max(0, count));
}

const ROLE_LABEL: Record<HistoryRole, string> = { user: "You", agent: "Agent" };

/** What a restored message that looks like a secret is replaced by. */
export const HISTORY_SECRET_PLACEHOLDER = "[сообщение скрыто: похоже на секрет]";

const BOT_TOKEN_SHAPE = /\d{6,}:[A-Za-z0-9_-]{30,}/;
// base64url runs from 32; a standard-base64 run (`+`, `/`) only from 40, because a URL path or a
// file path is a long run of letters, digits and slashes too and a 32-byte token is 43 characters.
const TOKEN_RUN = /[A-Za-z0-9_-]{32,}|[A-Za-z0-9+/]{40,}={0,2}/g;

// The words of a run: `Capitalised`, `lower`, `UPPER` (up to a following capitalised word), digits, a separator.
const RUN_PARTS = /[A-Z][a-z]+|[a-z]+|[A-Z]+(?![a-z])|\d+|[-_]/g;

/**
 * Whether a mixed-case run with a digit in it is a camelCase or snake_case identifier
 * (`createManagedReviewPackageForVersion2Handler`) and not a random token. Every word of an
 * identifier is a word: three letters or more (one or two only as the `v` of `v2` or the `V` of
 * `V2`, straight before its number), and at most three digits in a row. A base64 or hex token breaks
 * into one- and two-letter pieces and single digits within a few characters, so a 32-character
 * secret passing this is not a practical case. Pure.
 */
function isIdentifier(run: string): boolean {
  const parts = run.match(RUN_PARTS) ?? [];
  if (parts.join("") !== run) return false;
  // An identifier carries a version or two; a token scatters digits through the whole run.
  if (parts.filter((part) => /\d/.test(part)).length > 2) return false;
  return parts.every((part, index) => {
    if (/\d/.test(part)) return part.length <= 3;
    if (/[-_]/.test(part)) return true;
    return part.length >= 3 || /\d/.test(parts[index + 1] ?? "");
  });
}

/**
 * Whether `text` carries something that looks like a credential. The shared redactor catches the
 * shapes it knows (and mangles a Telegram bot token's number as a phone), so a pasted token can
 * come through whole or half. A restored turn is old text nobody is looking at: when in doubt it
 * is hidden, not posted. Two shapes: a Telegram bot token (`123456789:AAH…`), and any bare run of
 * 32 or more token characters (40 for the `+` and `/` alphabet) that mixes upper case, lower case and digits (a base64url or base64
 * secret; a hex hash is lower case only, a word has no digits, so neither matches), unless the run is
 * made only of words (a long camelCase identifier with a version number in it). Pure.
 */
export function looksLikeSecret(text: string): boolean {
  if (BOT_TOKEN_SHAPE.test(text)) return true;
  for (const run of text.match(TOKEN_RUN) ?? []) {
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && !isIdentifier(run)) return true;
  }
  return false;
}

/**
 * One restored message as the topic reads it: a role label, then the text. Redacted first and
 * cut after, so a secret is never shortened into something the redactor no longer recognises.
 * Text only, no time (the label tells who spoke; the order tells when).
 */
export function formatHistoryItem(item: HistoryItem): string {
  // The raw text, before the redactor: it is the redactor's blind spots this guards.
  if (looksLikeSecret(item.text)) return `${ROLE_LABEL[item.role]}:\n${HISTORY_SECRET_PLACEHOLDER}`;
  const safe = redactSensitiveText(item.text).trim();
  let body = safe;
  if (safe.length > HISTORY_ITEM_MAX_CHARS) {
    let end = HISTORY_ITEM_MAX_CHARS;
    // Do not cut a surrogate pair in half.
    const last = safe.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    body = `${safe.slice(0, end).trimEnd()}…`;
  }
  return `${ROLE_LABEL[item.role]}:\n${body}`;
}

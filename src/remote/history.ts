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
import { looksLikeSecret } from "../security/secret-shape";

export { looksLikeSecret };

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

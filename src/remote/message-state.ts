// How a message from the topic shows where it is (flow 387, AC18 and AC19): one reaction on the
// message, replaced as it moves, and the "typing" chat action while a turn runs.
//
//   received (eyes) -> reading -> working -> done | failed
//
// Telegram only accepts reactions from its own list. The failure state is the thumbs-down: the
// cross mark is not on that list, so a bot cannot put it on a message.

import type { MessageState } from "./protocol";

/** Every state a message passes through, "received" first. */
export type ReactionState = "received" | MessageState;

/** Emoji written as escapes so the source stays ASCII. */
export const REACTION_FOR_STATE: Readonly<Record<ReactionState, string>> = {
  received: "\u{1F440}",
  reading: "\u{1F914}",
  working: "\u{26A1}",
  done: "\u{1F44D}",
  failed: "\u{1F44E}",
};

/** How often the typing indicator is refreshed while a turn runs (Telegram clears it after about five seconds). */
export const TYPING_REFRESH_MS = 4_000;
/** One reaction or chat action call may take this long before the next in line goes ahead of it. */
export const STATE_CALL_TIMEOUT_MS = 5_000;
/** Messages whose state is still tracked, per hub. The oldest are forgotten. */
export const MAX_TRACKED_MESSAGES = 256;

/**
 * Whether a Telegram refusal means "this bot may not react here" (as opposed to one message that
 * is gone). Only the first turns reactions off for good.
 */
export function isReactionForbidden(status: number | undefined, message: string): boolean {
  if (status === 403) {
    return true;
  }
  return /REACTION_INVALID|REACTIONS?_(DISABLED|NOT_ALLOWED)|not enough rights|reactions? (are|is) (disabled|not allowed)|CHAT_ADMIN_REQUIRED/i.test(message);
}

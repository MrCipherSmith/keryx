// Shared types for the remote-control serve side (flow 376, block 1).
//
// A leaf module: nothing in `src/remote` is imported from here, so every other
// file may depend on it without creating a cycle. (`rich-types.ts` is a leaf too: types only.)

import type { InputRichMessage } from "./rich-types";

/** A Telegram user as far as this package cares: only the numeric id is read. */
export interface BotUser {
  id: number;
}

export interface BotMessage {
  message_id: number;
  /** Set for a message sent inside a forum topic. */
  message_thread_id?: number;
  from?: BotUser;
  chat: { id: number; type?: string };
  /** Unix seconds. */
  date: number;
  text?: string;
  /**
   * The message this one answers (flow 401). In a forum topic Telegram also sets it on a plain
   * message, to the topic's first message; only the id is read, and only to match an armed own-answer prompt.
   */
  reply_to_message?: { message_id: number };
  /** Set when the message was forwarded from somewhere else (Bot API 7+ and the older fields). */
  forward_origin?: unknown;
  forward_date?: number;
  /** Service message on a basic group that became a supergroup (Topics turned on): the supergroup's NEW chat id. */
  migrate_to_chat_id?: number;
  /** The matching service message on the new supergroup: the old group's chat id. */
  migrate_from_chat_id?: number;
}

/** The part of a Telegram `my_chat_member` update the pairing reads: who changed the bot's membership, and where. */
export interface BotChatMemberUpdate {
  chat: { id: number; type?: string; title?: string };
  from: BotUser;
  date: number;
  old_chat_member: { status: string };
  new_chat_member: { status: string };
}

export interface BotIdentity {
  id: number;
  username?: string;
}

export interface BotChatInfo {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
}

export interface BotChatMemberInfo {
  status: string;
  can_manage_topics?: boolean;
}

export interface BotCallbackQuery {
  id: string;
  from: BotUser;
  data?: string;
  /** The message the pressed button belongs to. */
  message?: BotMessage;
}

export interface BotUpdate {
  update_id: number;
  message?: BotMessage;
  callback_query?: BotCallbackQuery;
  my_chat_member?: BotChatMemberUpdate;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Rows of buttons, as Telegram's `inline_keyboard`. */
export type InlineKeyboard = InlineButton[][];

export interface GetUpdatesParams {
  /** Updates with a lower id are confirmed and dropped by Telegram. */
  offset?: number;
  /** Long-poll seconds. 0 returns at once. */
  timeoutSec?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface SendMessageParams {
  chatId: number;
  text: string;
  messageThreadId?: number;
  inlineKeyboard?: InlineKeyboard;
  /**
   * Flow 401: ask Telegram to open the reply box on this message (`force_reply`), with `placeholder`
   * in the input field. Mutually exclusive with `inlineKeyboard`; never sent as a rich message.
   */
  forceReply?: { placeholder?: string };
  /** Left out: plain text. "HTML": `text` is Telegram HTML (see `format-html.ts`). */
  parseMode?: "HTML";
}

/** `sendRichMessage` (Bot API 10.3): a message made of rich blocks instead of text. */
export interface SendRichMessageParams {
  chatId: number;
  richMessage: InputRichMessage;
  messageThreadId?: number;
  inlineKeyboard?: InlineKeyboard;
}

/** `editMessageText` with `rich_message` in place of `text` (Bot API 10.3). */
export interface EditRichMessageParams {
  chatId: number;
  messageId: number;
  richMessage: InputRichMessage;
  inlineKeyboard?: InlineKeyboard;
}

/** One entry of the bot's command menu (`setMyCommands`). Telegram: 1-32 chars of a-z, 0-9, `_`; description 1-256. */
export interface BotCommandMenuEntry {
  command: string;
  description: string;
}

/** A state shown on a message as a Telegram reaction: one emoji, or none to clear it. */
export type BotReactionEmoji = string;

/** The chat actions this package sends. */
export type BotChatAction = "typing";

export interface BotApi {
  getUpdates(params: GetUpdatesParams): Promise<BotUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<{ message_id: number }>;
  /**
   * Send a rich message (flow 395). Optional: a client that lacks it counts as "unsupported
   * method", and the caller falls back to `sendMessage` with HTML.
   */
  sendRichMessage?(params: SendRichMessageParams): Promise<{ message_id: number }>;
  /** Edit a message into a rich message (`editMessageText` with `rich_message`). Optional, like `sendRichMessage`. */
  editRichMessage?(params: EditRichMessageParams): Promise<void>;
  /**
   * Replace the inline keyboard of a message the bot sent. An empty or missing `inlineKeyboard`
   * removes the buttons. Telegram answers 400 "message is not modified" when nothing changes.
   */
  editMessageReplyMarkup(params: { chatId: number; messageId: number; inlineKeyboard?: InlineKeyboard }): Promise<void>;
  /** Replace the text (and optionally the keyboard) of a message the bot sent; no keyboard removes the buttons. */
  editMessageText(params: {
    chatId: number;
    messageId: number;
    text: string;
    parseMode?: "HTML";
    inlineKeyboard?: InlineKeyboard;
  }): Promise<void>;
  /** Set the bot's command menu for the group. */
  setMyCommands(params: { commands: BotCommandMenuEntry[]; chatId?: number }): Promise<void>;
  /** Put one reaction on a message, or clear it when `emoji` is undefined. */
  setMessageReaction(params: { chatId: number; messageId: number; emoji?: BotReactionEmoji }): Promise<void>;
  /** Show a chat action (the "typing" indicator) in a chat, or in one forum topic. */
  sendChatAction(params: { chatId: number; action: BotChatAction; messageThreadId?: number }): Promise<void>;
  createForumTopic(params: { chatId: number; name: string }): Promise<{ message_thread_id: number }>;
  deleteForumTopic(params: { chatId: number; messageThreadId: number }): Promise<void>;
  editForumTopic(params: { chatId: number; messageThreadId: number; name: string }): Promise<void>;
  answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void>;
  /** Who the token belongs to; a bad token is a `rejected` error (401). */
  getMe(): Promise<BotIdentity>;
  getChat(params: { chatId: number }): Promise<BotChatInfo>;
  getChatMember(params: { chatId: number; userId: number }): Promise<BotChatMemberInfo>;
}

export type BotApiErrorKind =
  /** HTTP 409: another getUpdates poller (or a webhook) owns the token. */
  | "conflict"
  /** HTTP 429: retry after `retryAfterSec`. */
  | "rate-limited"
  /** The request never produced a usable HTTP answer. Retryable. */
  | "network"
  /** Telegram answered 5xx. Retryable. */
  | "server"
  /** Telegram answered another 4xx (400 thread not found, 403, 401 ...). Not retryable. */
  | "rejected";

/**
 * The one error type the Bot API surface throws. `message` is already redacted:
 * it never carries the bot token, whatever the transport put in its own error.
 */
export class BotApiError extends Error {
  readonly kind: BotApiErrorKind;
  readonly status?: number;
  readonly retryAfterSec?: number;

  constructor(kind: BotApiErrorKind, message: string, extra: { status?: number; retryAfterSec?: number } = {}) {
    super(message);
    this.name = "BotApiError";
    this.kind = kind;
    if (extra.status !== undefined) {
      this.status = extra.status;
    }
    if (extra.retryAfterSec !== undefined) {
      this.retryAfterSec = extra.retryAfterSec;
    }
  }
}

export function isBotApiError(value: unknown): value is BotApiError {
  return value instanceof BotApiError;
}

/** Telegram's hard limit for the text of one message. */
export const TELEGRAM_MAX_TEXT = 4096;

/** What a failed attempt means for a queued message. */
export function isRetryable(error: unknown): boolean {
  if (!isBotApiError(error)) {
    return true;
  }
  return error.kind === "network" || error.kind === "server" || error.kind === "rate-limited";
}

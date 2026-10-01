// Shared types for the remote-control serve side (flow 376, block 1).
//
// A leaf module: nothing in `src/remote` is imported from here, so every other
// file may depend on it without creating a cycle.

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
  /** Set when the message was forwarded from somewhere else (Bot API 7+ and the older fields). */
  forward_origin?: unknown;
  forward_date?: number;
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
}

export interface BotApi {
  getUpdates(params: GetUpdatesParams): Promise<BotUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<{ message_id: number }>;
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

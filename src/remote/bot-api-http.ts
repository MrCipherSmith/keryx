// The real, fetch-based Bot API client (flow 376, block 1).
//
// This is the ONLY file in `src/remote` that may name the Telegram host or call
// `fetch`; `no-live-network.test.ts` holds that line. Everything else takes a
// `BotApi` and is tested against `fake-bot-api.ts`.
//
// The bot token lives only in this closure. It is in the request URL, so every
// error that crosses this file's boundary is rebuilt from scratch, never
// forwarded: a transport error message commonly carries the full URL, and with
// it the token. What leaves is `BotApiError` with a scrubbed, redacted message
// and no `cause`.

import { redactSensitiveText } from "../security/service";
import {
  type BotApi,
  BotApiError,
  type BotChatInfo,
  type BotChatMemberInfo,
  type BotIdentity,
  type BotUpdate,
  type GetUpdatesParams,
  type SendMessageParams,
} from "./types";

export const DEFAULT_BOT_API_BASE_URL = "https://api.telegram.org";

export interface HttpBotApiOptions {
  token: string;
  /** Injectable for tests and for pointing a smoke run at a local fake server. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Ceiling for any call other than a long poll. Default 30 s. */
  requestTimeoutMs?: number;
}

interface TelegramEnvelope {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

function scrubber(token: string): (text: string) => string {
  const secretHalf = token.includes(":") ? token.slice(token.indexOf(":") + 1) : "";
  const needles = [token, encodeURIComponent(token), secretHalf].filter((needle) => needle.length >= 8);
  return (text) => {
    let out = text;
    for (const needle of needles) {
      out = out.split(needle).join("[bot-token]");
    }
    return redactSensitiveText(out);
  };
}

function safeJson(text: string): TelegramEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as TelegramEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

export function createHttpBotApi(options: HttpBotApiOptions): BotApi {
  const { token } = options;
  if (token.length === 0) {
    throw new Error("bot token is empty");
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BOT_API_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const scrub = scrubber(token);

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs ?? requestTimeoutMs);
    const effective = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: effective,
      });
    } catch (error) {
      if (signal?.aborted === true) {
        // A caller-initiated abort is not a Bot API failure; keep the name so
        // callers can tell it apart without parsing text.
        const aborted = new Error("request aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      const reason = error instanceof Error ? error.name : "error";
      throw new BotApiError("network", scrub(`${method}: request failed (${reason})`));
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new BotApiError("network", `${method}: response body unreadable`, { status: response.status });
    }
    const envelope = safeJson(text);
    if (response.ok && envelope?.ok === true) {
      return envelope.result as T;
    }
    const status = response.status;
    const description = scrub(envelope?.description ?? `HTTP ${status}`);
    if (status === 409) {
      throw new BotApiError(
        "conflict",
        `${method}: 409 Conflict, another poller or webhook owns this bot token (${description})`,
        { status },
      );
    }
    if (status === 429) {
      const retryAfter = envelope?.parameters?.retry_after;
      throw new BotApiError("rate-limited", `${method}: 429 rate limited (${description})`, {
        status,
        retryAfterSec: typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 1,
      });
    }
    if (status >= 500) {
      throw new BotApiError("server", `${method}: ${status} ${description}`, { status });
    }
    throw new BotApiError("rejected", `${method}: ${status} ${description}`, { status });
  }

  return {
    async getUpdates(params: GetUpdatesParams): Promise<BotUpdate[]> {
      const timeoutSec = params.timeoutSec ?? 0;
      const body: Record<string, unknown> = {
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      };
      if (params.offset !== undefined) {
        body.offset = params.offset;
      }
      if (params.limit !== undefined) {
        body.limit = params.limit;
      }
      const updates = await call<BotUpdate[]>("getUpdates", body, params.signal, (timeoutSec + 15) * 1000);
      return Array.isArray(updates) ? updates : [];
    },
    async sendMessage(params: SendMessageParams) {
      const body: Record<string, unknown> = { chat_id: params.chatId, text: params.text };
      if (params.messageThreadId !== undefined) {
        body.message_thread_id = params.messageThreadId;
      }
      if (params.inlineKeyboard !== undefined) {
        body.reply_markup = { inline_keyboard: params.inlineKeyboard };
      }
      return call<{ message_id: number }>("sendMessage", body);
    },
    async createForumTopic(params) {
      return call<{ message_thread_id: number }>("createForumTopic", { chat_id: params.chatId, name: params.name });
    },
    async deleteForumTopic(params) {
      await call<boolean>("deleteForumTopic", {
        chat_id: params.chatId,
        message_thread_id: params.messageThreadId,
      });
    },
    async editForumTopic(params) {
      await call<boolean>("editForumTopic", {
        chat_id: params.chatId,
        message_thread_id: params.messageThreadId,
        name: params.name,
      });
    },
    async answerCallbackQuery(params) {
      const body: Record<string, unknown> = { callback_query_id: params.callbackQueryId };
      if (params.text !== undefined) {
        body.text = params.text;
      }
      await call<boolean>("answerCallbackQuery", body);
    },
    async getMe() {
      return call<BotIdentity>("getMe", {});
    },
    async getChat(params) {
      return call<BotChatInfo>("getChat", { chat_id: params.chatId });
    },
    async getChatMember(params) {
      return call<BotChatMemberInfo>("getChatMember", { chat_id: params.chatId, user_id: params.userId });
    },
  };
}

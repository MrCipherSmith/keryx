// The Bot API 10.3 rich-message calls (flow 395; AC1, AC5): what the HTTP client puts on the wire
// and what the fake enforces, so the outbound tests stand on a double that behaves like Telegram.
// Fake API and a stub fetch only; no socket, no token.

import { describe, expect, test } from "bun:test";
import { createHttpBotApi } from "./bot-api-http";
import { checkRichMessage, FakeBotApi } from "./fake-bot-api";
import { RICH_LIMITS, type InputRichMessage } from "./rich-types";
import { BotApiError } from "./types";

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function stubFetch(captured: Captured[], reply: { status?: number; body?: unknown } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, method: url.slice(url.lastIndexOf("/") + 1), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify(reply.body ?? { ok: true, result: { message_id: 7 } }), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
}

const cell = (text: string, header = false) => ({ text, align: "left" as const, valign: "top" as const, ...(header ? { is_header: true as const } : {}) });
const MESSAGE: InputRichMessage = {
  blocks: [{ type: "table", is_bordered: true, cells: [[cell("a", true)], [cell("1")]] }],
};
const KEYBOARD = [[{ text: "Yes", callback_data: "y" }]];

describe("the HTTP client", () => {
  test("sendRichMessage posts chat_id and rich_message to sendRichMessage, with the thread and keyboard when given", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured) });
    const sent = await api.sendRichMessage?.({ chatId: -100, messageThreadId: 5, richMessage: MESSAGE, inlineKeyboard: KEYBOARD });
    expect(sent).toEqual({ message_id: 7 });
    expect(captured[0]?.method).toBe("sendRichMessage");
    expect(captured[0]?.body).toEqual({
      chat_id: -100,
      message_thread_id: 5,
      rich_message: MESSAGE,
      reply_markup: { inline_keyboard: KEYBOARD },
    });
    expect(captured[0]?.body).not.toHaveProperty("text");
    expect(captured[0]?.body).not.toHaveProperty("parse_mode");
  });

  test("with no thread and no keyboard those fields are absent, not null", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured) });
    await api.sendRichMessage?.({ chatId: -100, richMessage: MESSAGE });
    expect(Object.keys(captured[0]?.body ?? {}).sort()).toEqual(["chat_id", "rich_message"]);
  });

  test("editRichMessage is editMessageText with rich_message, and an empty keyboard unless one is given", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured, { body: { ok: true, result: true } }) });
    await api.editRichMessage?.({ chatId: -100, messageId: 9, richMessage: MESSAGE });
    expect(captured[0]?.method).toBe("editMessageText");
    expect(captured[0]?.body).toEqual({ chat_id: -100, message_id: 9, rich_message: MESSAGE, reply_markup: { inline_keyboard: [] } });
    expect(captured[0]?.body).not.toHaveProperty("text");
  });

  for (const status of [400, 403, 404, 405]) {
    test(`a ${status} on sendRichMessage is a rejected error, which the outbound chain turns into a fallback`, async () => {
      const api = createHttpBotApi({
        token: "123:abc",
        fetchImpl: stubFetch([], { status, body: { ok: false, error_code: status, description: "Bad Request: rich_message is invalid" } }),
      });
      const error = await api.sendRichMessage?.({ chatId: 1, richMessage: MESSAGE }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BotApiError);
      expect((error as BotApiError).kind).toBe("rejected");
      expect((error as BotApiError).status).toBe(status);
    });
  }

  test("a 5xx and a 429 keep their kinds: they are retried, never read as a refusal of the format", async () => {
    const down = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch([], { status: 502, body: { ok: false, description: "Bad Gateway" } }) });
    const limited = createHttpBotApi({
      token: "123:abc",
      fetchImpl: stubFetch([], { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 4 } } }),
    });
    expect(((await down.sendRichMessage?.({ chatId: 1, richMessage: MESSAGE }).catch((e: unknown) => e)) as BotApiError).kind).toBe("server");
    const error = (await limited.sendRichMessage?.({ chatId: 1, richMessage: MESSAGE }).catch((e: unknown) => e)) as BotApiError;
    expect(error.kind).toBe("rate-limited");
    expect(error.retryAfterSec).toBe(4);
  });

  test("an error never carries the bot token, even when Telegram echoes the URL", async () => {
    const token = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789";
    const api = createHttpBotApi({
      token,
      fetchImpl: stubFetch([], { status: 400, body: { ok: false, description: `Bad Request: https://relay.invalid/bot${token}/sendRichMessage` } }),
    });
    const error = (await api.sendRichMessage?.({ chatId: 1, richMessage: MESSAGE }).catch((e: unknown) => e)) as BotApiError;
    expect(error.message).not.toContain("ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789");
  });
});

describe("the fake enforces the documented limits (spike: rich-message-limits)", () => {
  const paragraphs = (count: number): InputRichMessage => ({ blocks: Array.from({ length: count }, () => ({ type: "paragraph" as const, text: "x" })) });

  test("a message with exactly one of the three inputs, one non-empty block list, passes", () => {
    expect(checkRichMessage(MESSAGE)).toBeUndefined();
  });

  test("an empty list, a second input field and html/markdown are refused", () => {
    expect(checkRichMessage({ blocks: [] })).toBeDefined();
    expect(checkRichMessage({ blocks: MESSAGE.blocks, html: "<b>x</b>" } as unknown as InputRichMessage)).toBeDefined();
    expect(checkRichMessage({ html: "<b>x</b>" } as unknown as InputRichMessage)).toBeDefined();
  });

  test(`${RICH_LIMITS.blocks} blocks is the most; one more is refused`, () => {
    expect(checkRichMessage(paragraphs(RICH_LIMITS.blocks))).toBeUndefined();
    expect(checkRichMessage(paragraphs(RICH_LIMITS.blocks + 1))).toContain("too many blocks");
  });

  test(`${RICH_LIMITS.characters} characters is the most; one more is refused`, () => {
    expect(checkRichMessage({ blocks: [{ type: "paragraph", text: "x".repeat(RICH_LIMITS.characters) }] })).toBeUndefined();
    expect(checkRichMessage({ blocks: [{ type: "paragraph", text: "x".repeat(RICH_LIMITS.characters + 1) }] })).toContain("too long");
  });

  test(`${RICH_LIMITS.tableColumns} table columns is the most`, () => {
    const row = (count: number) => Array.from({ length: count }, () => cell("c"));
    expect(checkRichMessage({ blocks: [{ type: "table", cells: [row(RICH_LIMITS.tableColumns)] }] })).toBeUndefined();
    expect(checkRichMessage({ blocks: [{ type: "table", cells: [row(RICH_LIMITS.tableColumns + 1)] }] })).toContain("columns");
  });

  test(`${RICH_LIMITS.nesting} levels of nesting is the most`, () => {
    const nest = (levels: number): InputRichMessage => {
      let blocks: InputRichMessage["blocks"] = [{ type: "paragraph", text: "x" }];
      for (let level = 1; level < levels; level += 1) {
        blocks = [{ type: "blockquote", blocks }];
      }
      return { blocks };
    };
    expect(checkRichMessage(nest(RICH_LIMITS.nesting))).toBeUndefined();
    expect(checkRichMessage(nest(RICH_LIMITS.nesting + 1))).toContain("nested");
  });
});

describe("the fake's rich calls", () => {
  test("a rich message is stored with no text and no parse mode, and recorded as a call", async () => {
    const fake = new FakeBotApi();
    await fake.sendRichMessage({ chatId: fake.chatId, richMessage: MESSAGE, inlineKeyboard: KEYBOARD });
    expect(fake.callCount("sendRichMessage")).toBe(1);
    expect(fake.sent[0]).toMatchObject({ text: "", richMessage: MESSAGE, inlineKeyboard: KEYBOARD });
    expect(fake.sent[0]?.parseMode).toBeUndefined();
  });

  test("an invalid message is a 400, a bot that may not send them is a 403, an old server a 404", async () => {
    const fake = new FakeBotApi();
    const bad = await fake.sendRichMessage({ chatId: fake.chatId, richMessage: { blocks: [] } }).catch((e: unknown) => e);
    expect((bad as BotApiError).status).toBe(400);
    fake.setRichSupport("forbidden");
    expect(((await fake.sendRichMessage({ chatId: fake.chatId, richMessage: MESSAGE }).catch((e: unknown) => e)) as BotApiError).status).toBe(403);
    fake.setRichSupport("unsupported");
    expect(((await fake.sendRichMessage({ chatId: fake.chatId, richMessage: MESSAGE }).catch((e: unknown) => e)) as BotApiError).status).toBe(404);
    fake.setRichSupport("allowed");
    await fake.sendRichMessage({ chatId: fake.chatId, richMessage: MESSAGE });
    expect(fake.sent).toHaveLength(1);
  });

  test("editing a text message into a rich one, and back, changes what is stored", async () => {
    const fake = new FakeBotApi();
    const { message_id } = await fake.sendMessage({ chatId: fake.chatId, text: "hello", parseMode: "HTML" });
    await fake.editRichMessage({ chatId: fake.chatId, messageId: message_id, richMessage: MESSAGE });
    expect(fake.sent[0]).toMatchObject({ text: "", richMessage: MESSAGE });
    expect(fake.sent[0]?.parseMode).toBeUndefined();
    expect(fake.edits[0]).toMatchObject({ kind: "rich", messageId: message_id });
  });

  test("an identical rich edit is 'message is not modified', as Telegram answers it", async () => {
    const fake = new FakeBotApi();
    const { message_id } = await fake.sendRichMessage({ chatId: fake.chatId, richMessage: MESSAGE });
    const error = (await fake.editRichMessage({ chatId: fake.chatId, messageId: message_id, richMessage: MESSAGE }).catch((e: unknown) => e)) as BotApiError;
    expect(error.status).toBe(400);
    expect(error.message).toContain("message is not modified");
  });

  test("an edit of a message that does not exist is refused", async () => {
    const fake = new FakeBotApi();
    const error = (await fake.editRichMessage({ chatId: fake.chatId, messageId: 999, richMessage: MESSAGE }).catch((e: unknown) => e)) as BotApiError;
    expect(error).toBeInstanceOf(BotApiError);
  });

  test("failNext injects an error on the rich method only", async () => {
    const fake = new FakeBotApi();
    fake.failNext("sendRichMessage", new BotApiError("network", "boom"));
    await expect(fake.sendRichMessage({ chatId: fake.chatId, richMessage: MESSAGE })).rejects.toThrow("boom");
    await fake.sendMessage({ chatId: fake.chatId, text: "still works" });
    await fake.sendRichMessage({ chatId: fake.chatId, richMessage: MESSAGE });
    expect(fake.sent).toHaveLength(2);
  });
});

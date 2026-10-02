// AC10: the Bot API client can edit a message's text and remove its inline keyboard,
// and the fake supports both. (Buttons gone after a press and after expiry: approval-edit.test.ts
// and picker-callbacks.test.ts.) Fake API only.

import { describe, expect, test } from "bun:test";
import { createHttpBotApi } from "./bot-api-http";
import { FakeBotApi } from "./fake-bot-api";
import { BotApiError } from "./types";

interface Captured {
  method: string;
  body: Record<string, unknown>;
}

function stubFetch(captured: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({
      method: url.slice(url.lastIndexOf("/") + 1),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

const KEYBOARD = [[{ text: "Allow", callback_data: "x:1" }, { text: "Deny", callback_data: "x:2" }]];

describe("the HTTP client edits messages", () => {
  test("editMessageReplyMarkup with no keyboard sends an empty keyboard (removes the buttons)", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured) });
    await api.editMessageReplyMarkup({ chatId: -100, messageId: 9 });
    await api.editMessageReplyMarkup({ chatId: -100, messageId: 9, inlineKeyboard: KEYBOARD });
    expect(captured[0]).toEqual({
      method: "editMessageReplyMarkup",
      body: { chat_id: -100, message_id: 9, reply_markup: { inline_keyboard: [] } },
    });
    expect(captured[1]?.body.reply_markup).toEqual({ inline_keyboard: KEYBOARD });
  });

  test("editMessageText carries the text, parse mode and an empty keyboard by default", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured) });
    await api.editMessageText({ chatId: -100, messageId: 9, text: "<b>done</b>", parseMode: "HTML" });
    expect(captured[0]).toEqual({
      method: "editMessageText",
      body: { chat_id: -100, message_id: 9, text: "<b>done</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
    });
  });

  test("a 400 from Telegram is a rejected BotApiError, not a retryable one", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const api = createHttpBotApi({ token: "123:abc", fetchImpl });
    const error = await api.editMessageReplyMarkup({ chatId: 1, messageId: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotApiError);
    expect((error as BotApiError).kind).toBe("rejected");
  });
});

describe("the fake Bot API edits messages the way Telegram does", () => {
  test("removing the keyboard changes the stored message and is recorded", async () => {
    const fake = new FakeBotApi();
    const topic = await fake.createForumTopic({ chatId: fake.chatId, name: "t" });
    const sent = await fake.sendMessage({
      chatId: fake.chatId,
      messageThreadId: topic.message_thread_id,
      text: "Pick",
      inlineKeyboard: KEYBOARD,
    });
    expect(fake.message(sent.message_id)?.inlineKeyboard).toEqual(KEYBOARD);
    await fake.editMessageReplyMarkup({ chatId: fake.chatId, messageId: sent.message_id });
    expect(fake.message(sent.message_id)?.inlineKeyboard).toBeUndefined();
    expect(fake.edits).toMatchObject([{ messageId: sent.message_id, kind: "markup", inlineKeyboard: [] }]);
  });

  test("editing the text replaces text and keyboard; HTML is validated like a send", async () => {
    const fake = new FakeBotApi();
    const sent = await fake.sendMessage({ chatId: fake.chatId, text: "Pick", inlineKeyboard: KEYBOARD });
    await fake.editMessageText({ chatId: fake.chatId, messageId: sent.message_id, text: "<b>Allowed</b>", parseMode: "HTML" });
    expect(fake.message(sent.message_id)).toMatchObject({ text: "<b>Allowed</b>", parseMode: "HTML" });
    expect(fake.message(sent.message_id)?.inlineKeyboard).toBeUndefined();
    const bad = await fake
      .editMessageText({ chatId: fake.chatId, messageId: sent.message_id, text: "<b>open", parseMode: "HTML" })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(BotApiError);
  });

  test("an unknown message and an unchanged edit are 400s", async () => {
    const fake = new FakeBotApi();
    const missing = await fake.editMessageReplyMarkup({ chatId: fake.chatId, messageId: 5 }).catch((e: unknown) => e);
    expect((missing as BotApiError).kind).toBe("rejected");
    expect((missing as BotApiError).message).toContain("message to edit not found");
    const sent = await fake.sendMessage({ chatId: fake.chatId, text: "Plain" });
    const same = await fake.editMessageReplyMarkup({ chatId: fake.chatId, messageId: sent.message_id }).catch((e: unknown) => e);
    expect((same as BotApiError).message).toContain("message is not modified");
  });

  test("an injected fault reaches the edit call", async () => {
    const fake = new FakeBotApi();
    const sent = await fake.sendMessage({ chatId: fake.chatId, text: "Pick", inlineKeyboard: KEYBOARD });
    fake.failNext("editMessageReplyMarkup", new BotApiError("network", "down"));
    await expect(fake.editMessageReplyMarkup({ chatId: fake.chatId, messageId: sent.message_id })).rejects.toThrow("down");
    expect(fake.message(sent.message_id)?.inlineKeyboard).toEqual(KEYBOARD);
  });
});

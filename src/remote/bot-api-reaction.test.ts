// AC20: the Bot API client sends reactions and chat actions; the fake records both;
// a group that forbids reactions is a 400 the client reports as `rejected`.
// (The hub-level degradation is tested in message-state.test.ts.) Fake API only.

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

describe("the HTTP client carries reactions and chat actions", () => {
  test("setMessageReaction sends one emoji reaction, or an empty list to clear it", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured) });
    await api.setMessageReaction({ chatId: -100, messageId: 7, emoji: "\u{1F440}" });
    await api.setMessageReaction({ chatId: -100, messageId: 7 });
    expect(captured[0]).toEqual({
      method: "setMessageReaction",
      body: { chat_id: -100, message_id: 7, reaction: [{ type: "emoji", emoji: "\u{1F440}" }] },
    });
    expect(captured[1]?.body.reaction).toEqual([]);
  });

  test("sendChatAction carries the action and the topic's thread id", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured) });
    await api.sendChatAction({ chatId: -100, action: "typing", messageThreadId: 42 });
    await api.sendChatAction({ chatId: -100, action: "typing" });
    expect(captured[0]).toEqual({ method: "sendChatAction", body: { chat_id: -100, action: "typing", message_thread_id: 42 } });
    expect(captured[1]?.body).toEqual({ chat_id: -100, action: "typing" });
  });

  test("setMyCommands scopes the menu to the chat when one is given", async () => {
    const captured: Captured[] = [];
    const api = createHttpBotApi({ token: "123:abc", fetchImpl: stubFetch(captured) });
    await api.setMyCommands({ commands: [{ command: "help", description: "Show commands" }], chatId: -100 });
    expect(captured[0]?.body).toEqual({
      commands: [{ command: "help", description: "Show commands" }],
      scope: { type: "chat", chat_id: -100 },
    });
  });
});

describe("the fake Bot API records reactions and chat actions", () => {
  test("a reaction is recorded, the last call per message wins, and clearing is recorded", async () => {
    const fake = new FakeBotApi();
    const update = fake.pushMessage({ fromId: 1, text: "hi" });
    const messageId = update.message?.message_id ?? 0;
    await fake.setMessageReaction({ chatId: fake.chatId, messageId, emoji: "\u{1F440}" });
    await fake.setMessageReaction({ chatId: fake.chatId, messageId, emoji: "\u{1F525}" });
    expect(fake.reactions.map((entry) => entry.emoji)).toEqual(["\u{1F440}", "\u{1F525}"]);
    expect(fake.reactionOn(messageId)).toBe("\u{1F525}");
    await fake.setMessageReaction({ chatId: fake.chatId, messageId });
    expect(fake.reactionOn(messageId)).toBeUndefined();
    expect(fake.callCount("setMessageReaction")).toBe(3);
  });

  test("a chat action is recorded with its thread id, and a missing topic is a 400", async () => {
    const fake = new FakeBotApi();
    const topic = await fake.createForumTopic({ chatId: fake.chatId, name: "t" });
    await fake.sendChatAction({ chatId: fake.chatId, action: "typing", messageThreadId: topic.message_thread_id });
    expect(fake.chatActions).toMatchObject([{ action: "typing", messageThreadId: topic.message_thread_id }]);
    const error = await fake.sendChatAction({ chatId: fake.chatId, action: "typing", messageThreadId: 999_999 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotApiError);
    expect((error as BotApiError).kind).toBe("rejected");
  });

  test("when the bot may not react, setMessageReaction is a rejected 400 and nothing is recorded", async () => {
    const fake = new FakeBotApi();
    const update = fake.pushMessage({ fromId: 1, text: "hi" });
    fake.setBotCanReact(false);
    const error = await fake
      .setMessageReaction({ chatId: fake.chatId, messageId: update.message?.message_id ?? 0, emoji: "\u{1F440}" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotApiError);
    expect((error as BotApiError).status).toBe(400);
    expect(fake.reactions).toEqual([]);
  });

  test("setMyCommands validates names and records the menu", async () => {
    const fake = new FakeBotApi();
    await fake.setMyCommands({ commands: [{ command: "help", description: "Show commands" }] });
    expect(fake.myCommands).toEqual([{ command: "help", description: "Show commands" }]);
    const bad = await fake.setMyCommands({ commands: [{ command: "Bad-Name", description: "x" }] }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(BotApiError);
    expect(fake.myCommands).toHaveLength(1);
  });
});

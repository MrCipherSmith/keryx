// Flow 387, AC19 (and the typing half of AC20): while a turn from the topic runs, the topic shows
// "typing". It is sent at once, refreshed about every 4 seconds (Telegram clears it after about five)
// and stopped when the turn ends. Fake Bot API and a manual clock only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TYPING_REFRESH_MS } from "./message-state";
import { type Harness, makeHarness, OWNER_ID, STALE_MS, until } from "./remote.test-helpers";
import { BotApiError } from "./types";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

async function topic(name?: string) {
  const hub = h.makeHub();
  const sessionId = `sess-typing-${name ?? "a"}`;
  const reg = await hub.register({ sessionId, project: `/work/${name ?? "app"}` });
  if (!reg.ok) throw new Error("register failed");
  await hub.start();
  return { hub, sessionId, threadId: reg.threadId };
}

async function received(threadId: number, text = "go") {
  const update = h.api.pushMessage({ fromId: OWNER_ID, text, threadId });
  await until(() => h.api.reactionOn(update.message?.message_id ?? 0) !== undefined, "the message to be received");
  return update.update_id;
}

describe("the typing indicator (AC19)", () => {
  test("the refresh period is about four seconds", () => {
    expect(TYPING_REFRESH_MS).toBeGreaterThanOrEqual(3_000);
    expect(TYPING_REFRESH_MS).toBeLessThanOrEqual(4_500);
  });

  test("starts at once when the turn starts, in the topic's own thread", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    expect(h.api.chatActions).toEqual([]);
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "the first typing action");
    expect(h.api.chatActions[0]).toMatchObject({ action: "typing", messageThreadId: threadId });
  });

  test("is refreshed every four seconds while the turn runs", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "the first typing action");
    await h.clock.advance(TYPING_REFRESH_MS - 1);
    expect(h.api.chatActions.length).toBe(1);
    await h.clock.advance(1);
    expect(h.api.chatActions.length).toBe(2);
    // The shell is alive: it keeps heartbeating while the turn runs.
    for (let step = 0; step < 3; step += 1) {
      await h.clock.advance(TYPING_REFRESH_MS);
      await hub.heartbeat(sessionId);
    }
    expect(h.api.chatActions.length).toBe(5);
  });

  test("stops when the turn is done", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    const timersBefore = h.clock.pendingTimers();
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    expect(h.clock.pendingTimers()).toBeGreaterThan(timersBefore);
    hub.messageState(sessionId, updateId, "done");
    await h.clock.advance(TYPING_REFRESH_MS * 5);
    expect(h.api.chatActions.length).toBe(1);
    expect(h.clock.pendingTimers()).toBeLessThanOrEqual(timersBefore);
  });

  test("stops when the turn failed", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    hub.messageState(sessionId, updateId, "failed");
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions.length).toBe(1);
  });

  test("stops when the shell goes away", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    hub.endActivity(sessionId);
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions.length).toBe(1);
  });

  test("stops when the shell stops answering and the hub marks the session unavailable", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    await h.clock.advance(STALE_MS);
    await until(() => hub.list()[0]?.status === "unavailable", "marked unavailable");
    const seen = h.api.chatActions.length;
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions.length).toBe(seen);
  });

  test("a message that is only queued (received, reading) does not show typing", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions).toEqual([]);
    hub.messageState(sessionId, updateId, "reading");
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions).toEqual([]);
  });

  test("a second message working at the same time does not start a second indicator", async () => {
    const { hub, sessionId, threadId } = await topic();
    const first = await received(threadId, "one");
    const second = await received(threadId, "two");
    hub.messageState(sessionId, first, "working");
    hub.messageState(sessionId, second, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    await h.clock.advance(TYPING_REFRESH_MS);
    expect(h.api.chatActions.length).toBe(2);
  });

  test("a message that settles while another turn of the topic still works does not stop the typing", async () => {
    const { hub, sessionId, threadId } = await topic();
    const turn = await received(threadId, "long turn");
    const slash = await received(threadId, "/status");
    hub.messageState(sessionId, turn, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    hub.messageState(sessionId, slash, "working");
    hub.messageState(sessionId, slash, "done");
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions.length).toBeGreaterThan(1);
    // The turn itself ends: now the indicator stops.
    hub.messageState(sessionId, turn, "done");
    const seen = h.api.chatActions.length;
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions.length).toBe(seen);
  });

  test("a failed message that settles while another turn works does not stop the typing either", async () => {
    const { hub, sessionId, threadId } = await topic();
    const turn = await received(threadId, "long turn");
    const other = await received(threadId, "/doctor");
    hub.messageState(sessionId, turn, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    hub.messageState(sessionId, other, "failed");
    await h.clock.advance(TYPING_REFRESH_MS * 2);
    expect(h.api.chatActions.length).toBeGreaterThan(1);
  });

  test("two topics type independently", async () => {
    const a = await topic("a");
    const b = await topic("b");
    const updateId = await received(a.threadId);
    a.hub.messageState(a.sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "typing in a");
    expect(h.api.chatActions.every((action) => action.messageThreadId === a.threadId)).toBe(true);
    expect(h.api.chatActions.some((action) => action.messageThreadId === b.threadId)).toBe(false);
  });

  test("a failed typing call does not stop the next one", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    h.api.failNext("sendChatAction", new BotApiError("network", "connection reset"));
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.callCount("sendChatAction") === 1, "the failed call");
    await h.clock.advance(TYPING_REFRESH_MS);
    await until(() => h.api.chatActions.length === 1, "the next one goes through");
  });

  test("stopping the hub clears the indicator", async () => {
    const { hub, sessionId, threadId } = await topic();
    const updateId = await received(threadId);
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    await hub.stop();
    await h.clock.advance(TYPING_REFRESH_MS * 3);
    expect(h.api.chatActions.length).toBe(1);
  });

  test("typing still shows when the bot may not react (AC20)", async () => {
    const { hub, sessionId, threadId } = await topic();
    h.api.setBotCanReact(false);
    const update = h.api.pushMessage({ fromId: OWNER_ID, text: "go", threadId });
    await until(() => hub.events().some((event) => event.type === "reactions-unavailable"), "reactions to be refused");
    hub.messageState(sessionId, update.update_id, "working");
    await until(() => h.api.chatActions.length === 1, "typing");
    await h.clock.advance(TYPING_REFRESH_MS);
    expect(h.api.chatActions.length).toBe(2);
    hub.messageState(sessionId, update.update_id, "done");
    await h.clock.advance(TYPING_REFRESH_MS * 2);
    expect(h.api.chatActions.length).toBe(2);
  });
});

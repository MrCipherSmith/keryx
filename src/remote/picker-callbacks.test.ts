// Flow 387, AC5: picker callback_data is at most 64 bytes, never starts with `ap:`, is single-use,
// expires, and is bound to the session, the message and the person asked. A replayed press, a press
// from another user, topic or session, and an expired press change nothing and are answered.
// Real serve and real client over loopback; Telegram is the fake.

import { afterEach, describe, expect, test } from "bun:test";
import type { RemoteClient } from "./client";
import { SECRET } from "./command.test-helpers";
import type { FakeSentMessage } from "./fake-bot-api";
import { parseChoiceCallback } from "./protocol";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { saveRemoteConfig } from "./config";
import { FAKE_CHAT_ID, OWNER_ID, settle, STRANGER_ID, testConfig, until } from "./remote.test-helpers";

const SECOND_ID = 4343;

let rig: Rig;
afterEach(async () => {
  await rig.cleanup();
});

async function session(sessionId: string, name: string): Promise<{ client: RemoteClient; threadId: number }> {
  const client = rig.makeClient({ sessionId, project: `/work/${name}`, name, onLine: () => undefined });
  const started = await client.start();
  if (!started.ok) {
    throw new Error(`session ${sessionId} did not start: ${started.message}`);
  }
  return { client, threadId: started.threadId };
}

async function untilPicker(threadId: number): Promise<{ message: FakeSentMessage; data: string[] }> {
  const find = (): FakeSentMessage | undefined => rig.api.sentTo(threadId).find((message) => message.inlineKeyboard !== undefined);
  await until(() => find() !== undefined, "the picker in the topic");
  const message = find() as FakeSentMessage;
  return { message, data: (message.inlineKeyboard ?? []).flat().map((button) => button.callback_data) };
}

function press(threadId: number, data: string, messageId: number, fromId = OWNER_ID): void {
  rig.api.pushCallback({ fromId, data, threadId, messageId });
}

function current(messageId: number): FakeSentMessage {
  const message = rig.api.message(messageId);
  if (message === undefined) {
    throw new Error(`message ${messageId} is not in the topic`);
  }
  return message;
}

function textsIn(threadId: number): string[] {
  return rig.api.sentTo(threadId).map((message) => message.text);
}

describe("callback_data of a picker button (AC5)", () => {
  test("is at most 64 bytes and never starts with ap:, even for the largest keyboard and long labels", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0001", "release");
    const long = "é".repeat(60);
    const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((row) => [`${long}${row}a`, `${long}${row}b`, `${long}${row}c`]);
    const pending = client.requestChoice("Pick one", rows, 5_000);
    const { message, data } = await untilPicker(threadId);
    expect(data).toHaveLength(24);
    for (const value of data) {
      expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(64);
      expect(value.startsWith("ap:")).toBe(false);
      expect(parseChoiceCallback(value)).toBeDefined();
    }
    expect(new Set(data).size).toBe(24);
    press(threadId, data[5] as string, message.messageId);
    expect(await pending).toBe(5);
  });

  test("does not carry the label", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0002", "release");
    const pending = client.requestChoice("Pick one", [["Delta"], ["Echo"]], 5_000);
    const { message, data } = await untilPicker(threadId);
    for (const value of data) {
      expect(value).not.toContain("Delta");
      expect(value).not.toContain("Echo");
    }
    press(threadId, data[1] as string, message.messageId);
    expect(await pending).toBe(1);
  });

  test("a label with a secret is redacted before it reaches the topic", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0003", "release");
    const pending = client.requestChoice(`Pick (${SECRET})`, [[`k ${SECRET.slice(0, 50)}`]], 300);
    const { message } = await untilPicker(threadId);
    expect(JSON.stringify(message)).not.toContain("AbCdEfGhIjKlMnOp");
    expect(await pending).toBeUndefined();
  });
});

describe("a question serve refuses (review of flow 387, L-4)", () => {
  test("the ninth open question of a session is refused with the reason serve gave, not a silent timeout", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0012", "release");
    const open = Array.from({ length: 8 }, (_, index) => client.requestChoice(`Open ${index}`, [["Yes"], ["No"]], 5_000));
    await until(() => rig.api.sentTo(threadId).filter((message) => message.inlineKeyboard !== undefined).length === 8, "eight pickers in the topic");
    const ninth = await client.askChoice("One too many", [["Yes"], ["No"]], 5_000);
    expect(ninth.index).toBeUndefined();
    expect(ninth.refusal ?? "").toMatch(/too many/i);
    // The plain wrapper keeps its old contract: no answer.
    expect(await client.requestChoice("And again", [["Yes"]], 5_000)).toBeUndefined();
    await client.drop();
    await Promise.all(open);
  });

  test("a question that nobody answered in time has no refusal, only no answer", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client } = await session("sess-pk-0013", "release");
    const answer = await client.askChoice("Anyone?", [["Yes"]], 300);
    expect(answer.index).toBeUndefined();
    expect(answer.refusal).toBeUndefined();
  });
});

describe("a press is single-use (AC5)", () => {
  test("the first press answers; the message shows the result and loses its buttons; nothing else is sent", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0004", "release");
    const pending = client.requestChoice("Pick a model", [["Alpha"], ["Beta"]], 5_000);
    const { message, data } = await untilPicker(threadId);
    const sentBefore = textsIn(threadId).length;
    press(threadId, data[1] as string, message.messageId);
    expect(await pending).toBe(1);
    await until(() => current(message.messageId).text.includes("Chosen: Beta"), "the edit");
    const edited = current(message.messageId);
    expect(edited.inlineKeyboard).toBeUndefined();
    expect(edited.text).toContain(`user ${OWNER_ID}`);
    expect(edited.text).toContain("Pick a model");
    expect(textsIn(threadId)).toHaveLength(sentBefore);
    await until(() => rig.api.answeredCallbacks.length >= 1, "the press is answered");
  });

  test("a replayed press changes nothing and is answered", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0005", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000);
    const { message, data } = await untilPicker(threadId);
    press(threadId, data[0] as string, message.messageId);
    expect(await pending).toBe(0);
    await until(() => current(message.messageId).text.includes("Chosen: Alpha"), "the edit");
    const sentBefore = textsIn(threadId).length;
    const answered = rig.api.answeredCallbacks.length;

    press(threadId, data[1] as string, message.messageId);
    await until(() => rig.api.answeredCallbacks.length > answered, "the replay is answered");
    await settle();
    expect(current(message.messageId).text).toContain("Chosen: Alpha");
    expect(current(message.messageId).text).not.toContain("Chosen: Beta");
    expect(current(message.messageId).inlineKeyboard).toBeUndefined();
    expect(textsIn(threadId)).toHaveLength(sentBefore);
  });

  test("an index outside the keyboard changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0006", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000);
    const { message, data } = await untilPicker(threadId);
    const forged = (data[0] as string).replace(/:\d+$/, ":9");
    press(threadId, forged, message.messageId);
    await settle();
    expect(current(message.messageId).inlineKeyboard).toBeDefined();
    press(threadId, data[1] as string, message.messageId);
    expect(await pending).toBe(1);
  });
});

describe("a press is bound to the person, the message, the topic and the session (AC5)", () => {
  test("a press from someone who is not allowed in this group never reaches the prompt", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0007", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000, OWNER_ID);
    const { message, data } = await untilPicker(threadId);
    press(threadId, data[0] as string, message.messageId, STRANGER_ID);
    await settle();
    await settle();
    expect(current(message.messageId).inlineKeyboard).toBeDefined();
    expect(current(message.messageId).text).not.toContain("Chosen");
    press(threadId, data[1] as string, message.messageId, OWNER_ID);
    expect(await pending).toBe(1);
  });

  test("a press from another allowed user changes nothing when the prompt was asked of one person", async () => {
    rig = makeRig();
    const saved = saveRemoteConfig(testConfig({ chatId: FAKE_CHAT_ID, allowedUserIds: [OWNER_ID, SECOND_ID] }), rig.dir);
    expect(saved.ok).toBe(true);
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0010", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000, OWNER_ID);
    const { message, data } = await untilPicker(threadId);
    const answered = rig.api.answeredCallbacks.length;
    press(threadId, data[0] as string, message.messageId, SECOND_ID);
    // Telegram is told the press arrived so the button stops spinning, but nothing changes.
    await until(() => rig.api.answeredCallbacks.length > answered, "the press is answered");
    await settle();
    expect(current(message.messageId).inlineKeyboard).toBeDefined();
    expect(current(message.messageId).text).not.toContain("Chosen");
    press(threadId, data[1] as string, message.messageId, OWNER_ID);
    expect(await pending).toBe(1);
  });

  test("any allowed user may press a prompt that was not asked of one person", async () => {
    rig = makeRig();
    saveRemoteConfig(testConfig({ chatId: FAKE_CHAT_ID, allowedUserIds: [OWNER_ID, SECOND_ID] }), rig.dir);
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0011", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000);
    const { message, data } = await untilPicker(threadId);
    press(threadId, data[0] as string, message.messageId, SECOND_ID);
    expect(await pending).toBe(0);
  });

  test("a press on another message changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0008", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000);
    const { message, data } = await untilPicker(threadId);
    press(threadId, data[0] as string, message.messageId + 500);
    await settle();
    await settle();
    expect(current(message.messageId).inlineKeyboard).toBeDefined();
    press(threadId, data[0] as string, message.messageId);
    expect(await pending).toBe(0);
  });

  test("a press carrying this prompt from another session's topic changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const a = await session("sess-pk-000a", "alpha");
    const b = await session("sess-pk-000b", "beta");
    const pending = a.client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000);
    const { message, data } = await untilPicker(a.threadId);
    press(b.threadId, data[0] as string, message.messageId);
    await settle();
    await settle();
    expect(current(message.messageId).inlineKeyboard).toBeDefined();
    expect(current(message.messageId).text).not.toContain("Chosen");
    expect(textsIn(b.threadId).filter((text) => text.includes("Chosen"))).toEqual([]);
    press(a.threadId, data[1] as string, message.messageId);
    expect(await pending).toBe(1);
  });

  test("the other session's own prompts are not answered by this one's press", async () => {
    rig = makeRig();
    await rig.startServe();
    const a = await session("sess-pk-000c", "alpha");
    const b = await session("sess-pk-000d", "beta");
    const first = a.client.requestChoice("A?", [["x"], ["y"]], 600);
    const second = b.client.requestChoice("B?", [["x"], ["y"]], 5_000);
    const pickerA = await untilPicker(a.threadId);
    const pickerB = await untilPicker(b.threadId);
    expect(pickerA.data[0]).not.toBe(pickerB.data[0]);
    press(b.threadId, pickerB.data[1] as string, pickerB.message.messageId);
    expect(await second).toBe(1);
    expect(await first).toBeUndefined();
  });
});

describe("a press after the prompt expired (AC5)", () => {
  test("the prompt expires: buttons removed, nobody answered, a late press changes nothing", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-0009", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 300);
    const { message, data } = await untilPicker(threadId);
    expect(await pending).toBeUndefined();
    await until(() => current(message.messageId).text.includes("Expired at"), "the expiry edit");
    expect(current(message.messageId).inlineKeyboard).toBeUndefined();
    const sentBefore = textsIn(threadId).length;
    const answered = rig.api.answeredCallbacks.length;

    press(threadId, data[0] as string, message.messageId);
    await until(() => rig.api.answeredCallbacks.length > answered, "the late press is answered");
    await settle();
    expect(current(message.messageId).text).toContain("Expired at");
    expect(current(message.messageId).text).not.toContain("Chosen");
    expect(textsIn(threadId)).toHaveLength(sentBefore);
  });

  // Review of flow 387, T-3: the guard is `expiresAt > now()` at the press itself. The per-prompt timer
  // is the other thing that expires a prompt, and it can lag; this test moves the clock past the expiry
  // while that timer (5 s, real) has not fired, so only the guard can refuse the press.
  test("a press at the exact expiry is refused by the press itself, before the timer has run", async () => {
    rig = makeRig();
    let skewMs = 0;
    await rig.startServe({ service: { now: () => Date.now() + skewMs } });
    const { client, threadId } = await session("sess-pk-000f", "release");
    const pending = client.requestChoice("Pick", [["Alpha"], ["Beta"]], 5_000);
    const { message, data } = await untilPicker(threadId);
    // Past the 5 s the prompt was given; the real timer still has about 5 s to go.
    skewMs = 5_001;
    press(threadId, data[0] as string, message.messageId);
    await until(() => current(message.messageId).text.includes("Expired at"), "the expiry edit made by the press");
    expect(current(message.messageId).text).not.toContain("Chosen");
    expect(current(message.messageId).inlineKeyboard).toBeUndefined();
    // The shell is never told of a choice: its own wait runs out on its own clock, so drop it here.
    await client.drop();
    expect(await pending).toBeUndefined();
  });

  test("a press for an id the server never issued edits the stale message and nothing else", async () => {
    rig = makeRig();
    await rig.startServe();
    const { client, threadId } = await session("sess-pk-000e", "release");
    const pending = client.requestChoice("Pick", [["Alpha"]], 300);
    const { message } = await untilPicker(threadId);
    expect(await pending).toBeUndefined();
    await until(() => current(message.messageId).text.includes("Expired at"), "the expiry edit");
    press(threadId, "pk:000000000000:0", message.messageId);
    await settle();
    await settle();
    expect(current(message.messageId).inlineKeyboard).toBeUndefined();
  });
});

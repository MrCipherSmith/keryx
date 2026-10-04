// Flow 401, AC4 to AC8: an own-text answer to a Telegram question.
//
// The button posts a ForceReply; a reply by the same person to THAT message resolves that exact question.
// Binding is by reply-to message id and user id, never "the next message". Approvals have no such path.
// Real serve and real client over loopback; Telegram is the fake.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChoiceAnswer, RemoteClient } from "./client";
import { saveRemoteConfig } from "./config";
import { FakeBotApi, type FakeSentMessage } from "./fake-bot-api";
import { OutboundQueue } from "./outbound-queue";
import { OWN_ANSWER_BUTTON_LABEL, OWN_ANSWER_WINDOW_MS, ownCallbackData, parseChoiceCallback, parseOwnCallback } from "./protocol";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { FAKE_CHAT_ID, OWNER_ID, settle, testConfig, until } from "./remote.test-helpers";

const SECOND_ID = 4343;
const LATE_NOTE = "no longer open";

let rig: Rig;
let lines: string[];
afterEach(async () => {
  await rig.cleanup();
});

async function session(sessionId: string, name: string): Promise<{ client: RemoteClient; threadId: number }> {
  const client = rig.makeClient({ sessionId, project: `/work/${name}`, name, onLine: (text) => void lines.push(text) });
  const started = await client.start();
  if (!started.ok) {
    throw new Error(`session ${sessionId} did not start: ${started.message}`);
  }
  return { client, threadId: started.threadId };
}

function promptIn(threadId: number, nth = 0): FakeSentMessage | undefined {
  return rig.api.sentTo(threadId).filter((message) => message.inlineKeyboard !== undefined)[nth];
}

async function untilPrompt(threadId: number, nth = 0): Promise<FakeSentMessage> {
  await until(() => promptIn(threadId, nth) !== undefined, "the question in the topic");
  return promptIn(threadId, nth) as FakeSentMessage;
}

function ownButton(message: FakeSentMessage): string | undefined {
  return (message.inlineKeyboard ?? []).flat().find((button) => button.text === OWN_ANSWER_BUTTON_LABEL)?.callback_data;
}

async function untilOwnPrompt(threadId: number): Promise<FakeSentMessage> {
  const find = (): FakeSentMessage | undefined => rig.api.sentTo(threadId).find((message) => ownButton(message) !== undefined);
  await until(() => find() !== undefined, "an own-answerable question");
  return find() as FakeSentMessage;
}

function armedMessages(threadId: number): FakeSentMessage[] {
  return rig.api.sentTo(threadId).filter((message) => message.forceReply !== undefined);
}

async function pressOwn(threadId: number, prompt: FakeSentMessage, fromId = OWNER_ID): Promise<FakeSentMessage> {
  const before = armedMessages(threadId).length;
  rig.api.pushCallback({ fromId, data: ownButton(prompt) as string, threadId, messageId: prompt.messageId });
  await until(() => armedMessages(threadId).length > before, "the reply box");
  return armedMessages(threadId)[before] as FakeSentMessage;
}

function reply(threadId: number, text: string, toMessageId: number, fromId = OWNER_ID): void {
  rig.api.pushMessage({ fromId, text, threadId, replyToMessageId: toMessageId });
}

const textsIn = (threadId: number): string[] => rig.api.sentTo(threadId).map((message) => message.text);

function resolved(pending: Promise<ChoiceAnswer>): { value: () => ChoiceAnswer | undefined } {
  let value: ChoiceAnswer | undefined;
  void pending.then((answer) => {
    value = answer;
  });
  return { value: () => value };
}

const OPTIONS = [["1. Alpha"], ["2. Beta"]];

function twoUsers(): void {
  saveRemoteConfig(testConfig({ chatId: FAKE_CHAT_ID, allowedUserIds: [OWNER_ID, SECOND_ID] }), rig.dir);
}

describe("press, reply, resolve (AC4)", () => {
  test("the own button posts a ForceReply and a reply by the same person resolves that exact question", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0001", "release");
    const pending = client.askChoice("Which way?", OPTIONS, 5_000, { own: true, forUserId: OWNER_ID });
    const prompt = await untilPrompt(threadId);

    const data = ownButton(prompt) as string;
    expect(data).toBeDefined();
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(data.startsWith("ap:")).toBe(false);
    expect(parseOwnCallback(data)).toBeDefined();

    const armed = await pressOwn(threadId, prompt);
    expect(armed.forceReply).toBeDefined();
    expect(armed.inlineKeyboard).toBeUndefined();

    reply(threadId, "  Do the third thing instead  ", armed.messageId);
    expect(await pending).toEqual({ kind: "own", text: "Do the third thing instead" });
    await until(() => (rig.api.message(prompt.messageId)?.text ?? "").includes("Own answer"), "the question shows the answer");
    expect(rig.api.message(prompt.messageId)?.inlineKeyboard).toBeUndefined();
    expect(lines).toEqual([]);
  });

  test("a pressed option still resolves by position, and the own button is one row below the options", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0002", "release");
    const pending = client.askChoice("Which way?", OPTIONS, 5_000, { own: true });
    const prompt = await untilPrompt(threadId);
    const rows = prompt.inlineKeyboard ?? [];
    expect(rows[rows.length - 1]?.[0]?.text).toBe(OWN_ANSWER_BUTTON_LABEL);
    const first = rows[0]?.[0];
    rig.api.pushCallback({ fromId: OWNER_ID, data: first?.callback_data as string, threadId, messageId: prompt.messageId });
    expect(await pending).toEqual({ kind: "index", index: 0 });
  });

  test("a question asked without the own flag cannot be armed, even with a forged own callback", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0003", "release");
    const pending = resolved(client.askChoice("Which way?", OPTIONS, 5_000, { forUserId: OWNER_ID }));
    const prompt = await untilPrompt(threadId);
    expect(ownButton(prompt)).toBeUndefined();
    const first = (prompt.inlineKeyboard ?? [])[0]?.[0]?.callback_data as string;
    const promptId = parseChoiceCallback(first)?.promptId as string;
    rig.api.pushCallback({ fromId: OWNER_ID, data: ownCallbackData(promptId), threadId, messageId: prompt.messageId });
    await settle();
    expect(armedMessages(threadId)).toEqual([]);
    expect(pending.value()).toBeUndefined();
  });

  test("the ForceReply survives a restart of the outbound queue", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-own-queue-"));
    try {
      const api = new FakeBotApi();
      const first = new OutboundQueue({ api, dir, now: () => 1 });
      first.load();
      first.enqueue({ chatId: 1, text: "Reply here", forceReply: { placeholder: "Your own answer" } });
      const second = new OutboundQueue({ api, dir, now: () => 2 });
      second.load();
      expect(second.pending()[0]?.forceReply?.placeholder).toBe("Your own answer");
      await second.flush();
      expect(api.sent.map((m) => m.forceReply)).toEqual([{ placeholder: "Your own answer" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("only the reply to the armed message resolves (AC5)", () => {
  test("a typed line that is not a reply starts a normal turn and resolves nothing", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0003", "release");
    const pending = resolved(client.askChoice("Which way?", OPTIONS, 5_000, { own: true }));
    const prompt = await untilPrompt(threadId);
    await pressOwn(threadId, prompt);

    rig.api.pushMessage({ fromId: OWNER_ID, text: "just a normal line", threadId });
    await until(() => lines.includes("just a normal line"), "the line becomes a turn");
    await settle();
    expect(pending.value()).toBeUndefined();
  });

  test("a reply to the armed message never starts a turn, not even a second one after it resolved", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0004", "release");
    const pending = client.askChoice("Which way?", OPTIONS, 5_000, { own: true });
    const prompt = await untilPrompt(threadId);
    const armed = await pressOwn(threadId, prompt);

    reply(threadId, "my own answer", armed.messageId);
    expect(await pending).toEqual({ kind: "own", text: "my own answer" });
    reply(threadId, "a second reply", armed.messageId);
    await settle();
    await settle();
    expect(lines).toEqual([]);
  });

  test("a reply from another person resolves nothing and starts no turn", async () => {
    rig = makeRig();
    twoUsers();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0005", "release");
    const pending = resolved(client.askChoice("Which way?", OPTIONS, 5_000, { own: true, forUserId: OWNER_ID }));
    const prompt = await untilPrompt(threadId);
    const armed = await pressOwn(threadId, prompt);

    reply(threadId, "i am someone else", armed.messageId, SECOND_ID);
    await settle();
    await settle();
    expect(pending.value()).toBeUndefined();
    expect(lines).toEqual([]);
    // the person it was asked of can still answer
    reply(threadId, "the real answer", armed.messageId, OWNER_ID);
    await until(() => pending.value() !== undefined, "the answer");
    expect(pending.value()).toEqual({ kind: "own", text: "the real answer" });
  });

  test("another person cannot arm the question that was asked of one person", async () => {
    rig = makeRig();
    twoUsers();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0006", "release");
    const pending = resolved(client.askChoice("Which way?", OPTIONS, 5_000, { own: true, forUserId: OWNER_ID }));
    const prompt = await untilPrompt(threadId);
    rig.api.pushCallback({ fromId: SECOND_ID, data: ownButton(prompt) as string, threadId, messageId: prompt.messageId });
    await settle();
    await settle();
    expect(armedMessages(threadId)).toHaveLength(0);
    expect(pending.value()).toBeUndefined();
  });

  test("a reply to another message resolves nothing, and a reply to another question's box resolves only that one", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0007", "release");
    const first = resolved(client.askChoice("First?", OPTIONS, 5_000, { own: true }));
    const promptA = await untilPrompt(threadId, 0);
    const armedA = await pressOwn(threadId, promptA);
    const second = resolved(client.askChoice("Second?", OPTIONS, 5_000, { own: true }));
    const promptB = await untilPrompt(threadId, 1);
    const armedB = await pressOwn(threadId, promptB);
    expect(armedA.messageId).not.toBe(armedB.messageId);

    // a reply to the question message itself (not the box) is an ordinary line
    reply(threadId, "replying to the question text", promptA.messageId);
    await until(() => lines.includes("replying to the question text"), "an ordinary turn");
    expect(first.value()).toBeUndefined();
    expect(second.value()).toBeUndefined();

    reply(threadId, "answer for B", armedB.messageId);
    await until(() => second.value() !== undefined, "B answered");
    expect(second.value()).toEqual({ kind: "own", text: "answer for B" });
    await settle();
    expect(first.value()).toBeUndefined();
    reply(threadId, "answer for A", armedA.messageId);
    await until(() => first.value() !== undefined, "A answered");
    expect(first.value()).toEqual({ kind: "own", text: "answer for A" });
  });

  test("a reply posted in another session's topic to this session's box resolves nothing", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const one = await session("sess-own-0019", "release");
    const two = await session("sess-own-0020", "other");
    const pending = resolved(one.client.askChoice("Which way?", OPTIONS, 5_000, { own: true }));
    const prompt = await untilPrompt(one.threadId);
    const armed = await pressOwn(one.threadId, prompt);
    reply(two.threadId, "from the wrong topic", armed.messageId);
    await settle();
    await settle();
    expect(pending.value()).toBeUndefined();
    expect(lines).toEqual([]);
    reply(one.threadId, "from the right topic", armed.messageId);
    await until(() => pending.value() !== undefined, "the answer");
  });

  test("an empty reply is not an answer", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0008", "release");
    const pending = resolved(client.askChoice("Which way?", OPTIONS, 5_000, { own: true }));
    const prompt = await untilPrompt(threadId);
    const armed = await pressOwn(threadId, prompt);
    reply(threadId, "   ", armed.messageId);
    await settle();
    await settle();
    expect(pending.value()).toBeUndefined();
    expect(lines).toEqual([]);
    reply(threadId, "now a real one", armed.messageId);
    await until(() => pending.value() !== undefined, "the answer");
  });
});

describe("a late reply and the window (AC6)", () => {
  test("a reply after the window resolves nothing, and the operator gets one short message", async () => {
    rig = makeRig();
    lines = [];
    let clock = 1_000_000;
    await rig.startServe({ service: { now: () => clock } });
    const { client, threadId } = await session("sess-own-0009", "release");
    const pending = resolved(client.askChoice("Which way?", OPTIONS, 1_000, { own: true }));
    const prompt = await untilPrompt(threadId);
    const armed = await pressOwn(threadId, prompt);

    clock += OWN_ANSWER_WINDOW_MS + 1_000;
    reply(threadId, "too late", armed.messageId);
    await until(() => textsIn(threadId).some((text) => text.includes(LATE_NOTE)), "the late note");
    await settle();
    expect(textsIn(threadId).filter((text) => text.includes(LATE_NOTE))).toHaveLength(1);
    expect(pending.value()).toBeUndefined();
    expect(lines).toEqual([]);
  });

  test("the own-answer window is at least five minutes, even when the option timeout is far shorter", async () => {
    expect(OWN_ANSWER_WINDOW_MS).toBeGreaterThanOrEqual(5 * 60_000);
    rig = makeRig();
    lines = [];
    let clock = 1_000_000;
    await rig.startServe({ service: { now: () => clock } });
    const { client, threadId } = await session("sess-own-0010", "release");
    const pending = client.askChoice("Which way?", OPTIONS, 1_000, { own: true });
    const prompt = await untilPrompt(threadId);
    const armed = await pressOwn(threadId, prompt);
    clock += 5 * 60_000 - 1_000;
    reply(threadId, "just in time", armed.messageId);
    expect(await pending).toEqual({ kind: "own", text: "just in time" });
  });

  test("the option timeout is unchanged: an unarmed question closes after its own timeout", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0011", "release");
    const started = Date.now();
    const pending = client.askChoice("Which way?", OPTIONS, 250, { own: true });
    const prompt = await untilPrompt(threadId);
    expect(await pending).toEqual({ kind: "none" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(() => rig.api.message(prompt.messageId)?.inlineKeyboard === undefined, "the buttons are removed");
  });

  test("a question that expired while armed tells the shell at once instead of leaving it waiting", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0012", "release");
    const pending = client.askChoice("Which way?", OPTIONS, 5_000, { own: true });
    const prompt = await untilPrompt(threadId);
    await pressOwn(threadId, prompt);
    // the shell gives up: serve is told and closes the question
    await client.drop();
    await settle();
    expect(await pending).toEqual({ kind: "none" });
  });
});

describe("the question is shown once, and closed when answered elsewhere (AC7)", () => {
  test("a slash-command picker (no own flag) has no own button", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0013", "release");
    const pending = client.requestChoice("Pick a model", [["Alpha"], ["Beta"]], 5_000);
    const prompt = await untilPrompt(threadId);
    expect(ownButton(prompt)).toBeUndefined();
    expect(JSON.stringify(prompt.inlineKeyboard)).not.toContain(OWN_ANSWER_BUTTON_LABEL);
    expect(JSON.stringify(prompt.inlineKeyboard)).not.toContain('"o:');
    rig.api.pushCallback({ fromId: OWNER_ID, data: (prompt.inlineKeyboard ?? []).flat()[0]?.callback_data as string, threadId, messageId: prompt.messageId });
    expect(await pending).toBe(0);
  });

  test("an own callback aimed at a picker that never offered it does nothing", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0014", "release");
    const own = client.askChoice("Which way?", OPTIONS, 5_000, { own: true });
    const ownPrompt = await untilPrompt(threadId, 0);
    const forged = ownButton(ownPrompt) as string;
    let plain: number | undefined | "pending" = "pending";
    void client.requestChoice("Pick a model", [["Alpha"], ["Beta"]], 5_000).then((value) => {
      plain = value;
    });
    const plainPrompt = await untilPrompt(threadId, 1);
    rig.api.pushCallback({ fromId: OWNER_ID, data: forged, threadId, messageId: plainPrompt.messageId });
    await settle();
    await settle();
    expect(armedMessages(threadId)).toHaveLength(0);
    expect(plain).toBe("pending");
    expect(rig.api.message(plainPrompt.messageId)?.inlineKeyboard).toBeDefined();
    // the own-capable one is untouched too
    expect(rig.api.message(ownPrompt.messageId)?.inlineKeyboard).toBeDefined();
    void own;
  });

  test("answered in the shell: the shell closes the topic question and its box, and a later reply does nothing", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0015", "release");
    const abort = new AbortController();
    const pending = client.askChoice("Which way?", OPTIONS, 5_000, { own: true, signal: abort.signal });
    const prompt = await untilPrompt(threadId);
    const armed = await pressOwn(threadId, prompt);

    abort.abort("shell");
    expect(await pending).toEqual({ kind: "none" });
    await until(() => (rig.api.message(prompt.messageId)?.text ?? "").includes("Answered in the shell"), "the question is closed");
    expect(rig.api.message(prompt.messageId)?.inlineKeyboard).toBeUndefined();

    reply(threadId, "typed after the shell answered", armed.messageId);
    await until(() => textsIn(threadId).some((text) => text.includes(LATE_NOTE)), "told it is closed");
    expect(lines).toEqual([]);
  });

  test("the turn stopped: the topic question is closed as cancelled", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0016", "release");
    const abort = new AbortController();
    const pending = client.askChoice("Which way?", OPTIONS, 5_000, { own: true, signal: abort.signal });
    const prompt = await untilPrompt(threadId);
    abort.abort("cancelled");
    expect(await pending).toEqual({ kind: "none" });
    await until(() => (rig.api.message(prompt.messageId)?.text ?? "").includes("Cancelled"), "closed as cancelled");
  });

  test("answered in the topic first: the press wins and an abort afterwards changes nothing", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0017", "release");
    const abort = new AbortController();
    const pending = client.askChoice("Which way?", OPTIONS, 5_000, { own: true, signal: abort.signal });
    const prompt = await untilPrompt(threadId);
    const first = (prompt.inlineKeyboard ?? []).flat()[1];
    rig.api.pushCallback({ fromId: OWNER_ID, data: first?.callback_data as string, threadId, messageId: prompt.messageId });
    expect(await pending).toEqual({ kind: "index", index: 1 });
    abort.abort("shell");
    await settle();
    await settle();
    expect(rig.api.message(prompt.messageId)?.text ?? "").toContain("Chosen");
    expect(rig.api.message(prompt.messageId)?.text ?? "").not.toContain("Answered in the shell");
  });
});

describe("approvals have no own-answer path (AC8)", () => {
  for (const word of ["yes", "allow"]) {
    test(`"${word}" as an own answer and as a reply leaves an approval pending`, async () => {
      rig = makeRig();
      lines = [];
      await rig.startServe();
      const { client, threadId } = await session(`sess-own-08-${word}`, "release");

      let decision: string | undefined;
      void client.requestApproval("Run `rm -rf build`?", 5_000).then((value) => {
        decision = value;
      });
      await until(() => rig.api.sentTo(threadId).some((message) => (message.inlineKeyboard ?? []).flat().some((button) => button.callback_data.startsWith("ap:"))), "the approval");
      const approval = rig.api.sentTo(threadId).find((message) => (message.inlineKeyboard ?? []).flat().some((button) => button.callback_data.startsWith("ap:"))) as FakeSentMessage;
      // the approval has no own button and nothing in it parses as an own callback
      expect(JSON.stringify(approval.inlineKeyboard)).not.toContain(OWN_ANSWER_BUTTON_LABEL);
      for (const button of (approval.inlineKeyboard ?? []).flat()) {
        expect(parseOwnCallback(button.callback_data)).toBeUndefined();
      }

      // an own-answerable question beside it: the word is that question's answer, not the approval's
      const question = resolved(client.askChoice("Which way?", OPTIONS, 5_000, { own: true }));
      const prompt = await untilOwnPrompt(threadId);
      const armed = await pressOwn(threadId, prompt);
      reply(threadId, word, armed.messageId);
      await until(() => question.value() !== undefined, "the question takes the word as text");
      expect(question.value()).toEqual({ kind: "own", text: word });

      // a reply to the approval message itself is an ordinary line for the agent
      reply(threadId, word, approval.messageId);
      await until(() => lines.includes(word), "an ordinary line");
      // and a plain line
      rig.api.pushMessage({ fromId: OWNER_ID, text: word, threadId });
      await settle();
      await settle();
      expect(decision).toBeUndefined();

      // only its own button decides it
      const deny = (approval.inlineKeyboard ?? []).flat().find((button) => button.callback_data.startsWith("ap:") && /deny/i.test(button.text));
      rig.api.pushCallback({ fromId: OWNER_ID, data: (deny ?? (approval.inlineKeyboard ?? []).flat()[1])?.callback_data as string, threadId, messageId: approval.messageId });
      await until(() => decision !== undefined, "the approval is decided by its button");
      expect(decision).toBe("deny");
    });
  }

  test("an own callback aimed at an approval message arms nothing", async () => {
    rig = makeRig();
    lines = [];
    await rig.startServe();
    const { client, threadId } = await session("sess-own-0018", "release");
    void client.requestApproval("Run `ls`?", 5_000);
    await until(() => rig.api.sentTo(threadId).some((message) => (message.inlineKeyboard ?? []).flat().some((button) => button.callback_data.startsWith("ap:"))), "the approval");
    const approval = rig.api.sentTo(threadId).find((message) => (message.inlineKeyboard ?? []).flat().some((button) => button.callback_data.startsWith("ap:"))) as FakeSentMessage;
    const own = client.askChoice("Which way?", OPTIONS, 5_000, { own: true });
    const prompt = await untilOwnPrompt(threadId);
    rig.api.pushCallback({ fromId: OWNER_ID, data: ownButton(prompt) as string, threadId, messageId: approval.messageId });
    await settle();
    await settle();
    expect(armedMessages(threadId)).toHaveLength(0);
    void own;
  });
});

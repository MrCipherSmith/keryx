// Flow 387, AC18 and AC20: a message from the topic shows where it is as one reaction, replaced as
// it moves: received -> reading -> working -> done, or failed. The cross mark is not a reaction
// Telegram accepts, so failure is the thumbs-down. A bot that may not react degrades to typing only,
// with one hub event. Fake Bot API only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InboundMeta, RemoteClientOptions, StartResult } from "./client";
import { REACTION_FOR_STATE } from "./message-state";
import type { MessageState } from "./protocol";
import { type Harness, makeHarness, OWNER_ID, until } from "./remote.test-helpers";
import { RemoteBridge, type RemoteBridgeHost, TG_SOURCE } from "./shell-bridge";
import { BotApiError } from "./types";

const EYES = "\u{1F440}";
const READING = "\u{1F914}";
const WORKING = "\u{26A1}";
const DONE = "\u{1F44D}";
const FAILED = "\u{1F44E}";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

async function topic(sessionId = "sess-state-0001") {
  const hub = h.makeHub();
  const reg = await hub.register({ sessionId, project: "/work/app" });
  if (!reg.ok) throw new Error("register failed");
  await hub.start();
  return { hub, sessionId, threadId: reg.threadId };
}

function send(threadId: number, text = "do the thing") {
  const update = h.api.pushMessage({ fromId: OWNER_ID, text, threadId });
  return { updateId: update.update_id, messageId: update.message?.message_id ?? 0 };
}

describe("the states, as reactions on the message (AC18)", () => {
  test("the emoji for each state are distinct and none is the cross mark", () => {
    const emoji = Object.values(REACTION_FOR_STATE);
    expect(new Set(emoji).size).toBe(emoji.length);
    expect(emoji).not.toContain("\u{274C}");
    expect(REACTION_FOR_STATE.received).toBe(EYES);
    expect(REACTION_FOR_STATE.failed).toBe(FAILED);
  });

  test("a message gets the eyes as soon as it is received, and still reaches the shell", async () => {
    const { threadId } = await topic();
    const { messageId } = send(threadId);
    await until(() => h.deliveries.length === 1, "the delivery");
    await until(() => h.api.reactionOn(messageId) === EYES, "the eyes");
    expect(h.deliveries[0]?.line).toBe("do the thing");
  });

  test("it moves reading, working, done and each replaces the one before", async () => {
    const { hub, sessionId, threadId } = await topic();
    const { updateId, messageId } = send(threadId);
    await until(() => h.api.reactionOn(messageId) === EYES, "the eyes");
    for (const [state, emoji] of [["reading", READING], ["working", WORKING], ["done", DONE]] as const) {
      expect(hub.messageState(sessionId, updateId, state)).toBe(true);
      await until(() => h.api.reactionOn(messageId) === emoji, `the ${state} reaction`);
    }
    expect(h.api.reactions.filter((entry) => entry.messageId === messageId).map((entry) => entry.emoji)).toEqual([EYES, READING, WORKING, DONE]);
  });

  test("a failed run ends on the thumbs-down", async () => {
    const { hub, sessionId, threadId } = await topic();
    const { updateId, messageId } = send(threadId);
    await until(() => h.api.reactionOn(messageId) === EYES, "the eyes");
    hub.messageState(sessionId, updateId, "working");
    hub.messageState(sessionId, updateId, "failed");
    await until(() => h.api.reactionOn(messageId) === FAILED, "the failure reaction");
    expect(h.api.reactions.filter((entry) => entry.messageId === messageId).map((entry) => entry.emoji)).toEqual([EYES, WORKING, FAILED]);
  });

  test("states of two messages do not mix", async () => {
    const { hub, sessionId, threadId } = await topic();
    const first = send(threadId, "first");
    const second = send(threadId, "second");
    await until(() => h.api.reactionOn(first.messageId) === EYES && h.api.reactionOn(second.messageId) === EYES, "both eyes");
    hub.messageState(sessionId, first.updateId, "done");
    await until(() => h.api.reactionOn(first.messageId) === DONE, "the first done");
    expect(h.api.reactionOn(second.messageId)).toBe(EYES);
  });

  test("an unknown session or an unknown message is told so, and nothing is sent", async () => {
    const { hub, sessionId, threadId } = await topic();
    const { messageId } = send(threadId);
    await until(() => h.api.reactionOn(messageId) === EYES, "the eyes");
    const before = h.api.callCount("setMessageReaction");
    expect(hub.messageState("sess-nobody", 1, "done")).toBe(false);
    expect(hub.messageState(sessionId, 987_654, "done")).toBe(false);
    expect(h.api.callCount("setMessageReaction")).toBe(before);
  });

  test("the shell going away marks the message it was working on as failed", async () => {
    const { hub, sessionId, threadId } = await topic();
    const { updateId, messageId } = send(threadId);
    await until(() => h.api.reactionOn(messageId) === EYES, "the eyes");
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.reactionOn(messageId) === WORKING, "working");
    hub.endActivity(sessionId);
    await until(() => h.api.reactionOn(messageId) === FAILED, "the failure reaction");
  });

  test("a message already done is not touched when the shell goes away", async () => {
    const { hub, sessionId, threadId } = await topic();
    const { updateId, messageId } = send(threadId);
    await until(() => h.api.reactionOn(messageId) === EYES, "the eyes");
    hub.messageState(sessionId, updateId, "done");
    await until(() => h.api.reactionOn(messageId) === DONE, "done");
    hub.endActivity(sessionId);
    await until(() => true);
    expect(h.api.reactionOn(messageId)).toBe(DONE);
  });
});

describe("a reaction that fails never blocks the message (AC18, AC20)", () => {
  test("one failed call leaves the message delivered and the next state still goes through", async () => {
    const { hub, sessionId, threadId } = await topic();
    h.api.failNext("setMessageReaction", new BotApiError("rejected", "Bad Request: message to react not found", { status: 400 }));
    const { updateId, messageId } = send(threadId);
    await until(() => h.deliveries.length === 1, "the delivery");
    await until(() => h.api.callCount("setMessageReaction") === 1, "the failed call");
    hub.messageState(sessionId, updateId, "done");
    await until(() => h.api.reactionOn(messageId) === DONE, "done");
    expect(hub.events().filter((event) => event.type === "reactions-unavailable")).toEqual([]);
  });

  test("a network failure on a reaction is ignored too", async () => {
    const { hub, sessionId, threadId } = await topic();
    h.api.failNext("setMessageReaction", new BotApiError("network", "connection reset"));
    const { updateId, messageId } = send(threadId);
    await until(() => h.deliveries.length === 1, "the delivery");
    hub.messageState(sessionId, updateId, "working");
    await until(() => h.api.reactionOn(messageId) === WORKING, "working");
    expect(hub.events().filter((event) => event.type === "reactions-unavailable")).toEqual([]);
  });

  test("a bot that may not react degrades to typing only, with ONE hub event", async () => {
    const { hub, sessionId, threadId } = await topic();
    h.api.setBotCanReact(false);
    const first = send(threadId, "first");
    await until(() => h.deliveries.length === 1, "the first delivery");
    await until(() => hub.events().some((event) => event.type === "reactions-unavailable"), "the event");
    const second = send(threadId, "second");
    await until(() => h.deliveries.length === 2, "the second delivery");
    hub.messageState(sessionId, first.updateId, "working");
    hub.messageState(sessionId, second.updateId, "working");
    hub.messageState(sessionId, first.updateId, "done");
    await until(() => h.api.chatActions.length >= 1, "typing");
    expect(hub.events().filter((event) => event.type === "reactions-unavailable").length).toBe(1);
    // No further reaction calls once it is known they are refused.
    const calls = h.api.callCount("setMessageReaction");
    hub.messageState(sessionId, second.updateId, "done");
    await until(() => true);
    expect(h.api.callCount("setMessageReaction")).toBe(calls);
    expect(h.api.reactionOn(first.messageId)).toBeUndefined();
    expect(h.deliveries.map((delivery) => delivery.line)).toEqual(["first", "second"]);
  });

  test("the event says so in words and carries no message text", async () => {
    const { hub, threadId } = await topic();
    h.api.setBotCanReact(false);
    send(threadId, "a private line");
    await until(() => hub.events().some((event) => event.type === "reactions-unavailable"), "the event");
    const event = hub.events().find((entry) => entry.type === "reactions-unavailable");
    expect(event?.detail).toContain("may not react");
    expect(event?.detail).not.toContain("a private line");
  });
});

// ---- the shell side: which state is reported, and when ---------------------------------

interface Rig {
  bridge: RemoteBridge;
  reported: Array<[number, MessageState]>;
  busy: { value: boolean };
  ran: string[];
  queued: string[];
  send(text: string, updateId: number): void;
}

function bridgeRig(options: { rejectReports?: boolean } = {}): Rig {
  const reported: Array<[number, MessageState]> = [];
  const ran: string[] = [];
  const queued: string[] = [];
  const busy = { value: false };
  const host: RemoteBridgeHost = {
    sessionId: () => "sess-1",
    project: () => "/proj",
    isBusy: () => busy.value,
    runLine: (text) => void ran.push(text),
    enqueue: (text) => void queued.push(text),
    notice: () => undefined,
    cancelTurn: () => undefined,
    recordOn: () => undefined,
    recordOff: () => undefined,
    runCommand: async (line) => ({ output: `ran ${line}`, ok: !line.startsWith("/bad") }),
  };
  let onLine!: RemoteClientOptions["onLine"];
  const bridge = new RemoteBridge({
    host,
    approvalTimeoutMs: 50,
    makeClient: (clientOptions: RemoteClientOptions) => {
      onLine = clientOptions.onLine;
      const result: StartResult = { ok: true, name: "topic-a", threadId: 7, runTimeoutMs: 0 };
      return {
        get connected() {
          return true;
        },
        get name() {
          return "topic-a";
        },
        get runTimeoutMs() {
          return 0;
        },
        get lastHeartbeatAt() {
          return undefined;
        },
        start: async () => result,
        close: async () => undefined,
        reply: async () => true,
        requestApproval: async () => "deny" as const,
        requestChoice: async () => undefined,
        reportState: async (updateId: number, state: MessageState) => {
          reported.push([updateId, state]);
          if (options.rejectReports === true) throw new Error("serve is gone");
          return true;
        },
      };
    },
  });
  return {
    bridge,
    reported,
    busy,
    ran,
    queued,
    send: (text, updateId) => {
      const meta: InboundMeta = { updateId, threadId: 7, fromId: 9, receivedAt: 0 };
      onLine(text, meta);
    },
  };
}

describe("the shell reports each state in order (AC18)", () => {
  test("an idle line is reading, then working when its turn starts, then done", async () => {
    const rig = bridgeRig();
    await rig.bridge.enable();
    rig.send("fix the test", 11);
    expect(rig.ran).toEqual(["fix the test"]);
    rig.bridge.turnStarted(TG_SOURCE);
    await rig.bridge.turnSettled({ failed: false });
    expect(rig.reported).toEqual([[11, "reading"], [11, "working"], [11, "done"]]);
  });

  test("a failed turn is reported failed", async () => {
    const rig = bridgeRig();
    await rig.bridge.enable();
    rig.send("fix the test", 12);
    rig.bridge.turnStarted(TG_SOURCE);
    await rig.bridge.turnSettled({ failed: true });
    expect(rig.reported.map(([, state]) => state)).toEqual(["reading", "working", "failed"]);
  });

  test("a line queued behind a busy shell reports nothing until its own turn starts", async () => {
    const rig = bridgeRig();
    await rig.bridge.enable();
    rig.busy.value = true;
    rig.send("later", 21);
    expect(rig.queued).toEqual(["later"]);
    expect(rig.reported).toEqual([]);
    rig.busy.value = false;
    rig.bridge.turnStarted(TG_SOURCE);
    expect(rig.reported).toEqual([[21, "working"]]);
    await rig.bridge.turnSettled({ failed: false });
    expect(rig.reported.at(-1)).toEqual([21, "done"]);
  });

  test("two queued lines take their turns in order, each with its own message", async () => {
    const rig = bridgeRig();
    await rig.bridge.enable();
    rig.busy.value = true;
    rig.send("one", 31);
    rig.send("two", 32);
    rig.bridge.turnStarted(TG_SOURCE);
    await rig.bridge.turnSettled({ failed: false });
    rig.bridge.turnStarted(TG_SOURCE);
    await rig.bridge.turnSettled({ failed: false });
    expect(rig.reported).toEqual([[31, "working"], [31, "done"], [32, "working"], [32, "done"]]);
  });

  test("a queued line removed in the shell is reported failed", async () => {
    const rig = bridgeRig();
    await rig.bridge.enable();
    rig.busy.value = true;
    rig.send("never runs", 41);
    rig.bridge.queuedLineRemoved("never runs");
    expect(rig.reported).toEqual([[41, "failed"]]);
  });

  test("a turn that did not come from Telegram reports nothing", async () => {
    const rig = bridgeRig();
    await rig.bridge.enable();
    rig.bridge.turnStarted(undefined);
    await rig.bridge.turnSettled({ failed: false });
    expect(rig.reported).toEqual([]);
  });

  test("a command is reported done, or failed when the shell said it failed", async () => {
    const rig = bridgeRig();
    await rig.bridge.enable();
    rig.send("/status", 51);
    rig.send("/bad", 52);
    await rig.bridge.idle();
    expect(rig.reported).toContainEqual([51, "done"]);
    expect(rig.reported.filter(([id]) => id === 52).map(([, state]) => state).at(-1)).toBe("failed");
  });

  test("a report that cannot be delivered does not hold the line or the turn", async () => {
    const rig = bridgeRig({ rejectReports: true });
    await rig.bridge.enable();
    rig.send("go", 61);
    expect(rig.ran).toEqual(["go"]);
    rig.bridge.turnStarted(TG_SOURCE);
    await rig.bridge.turnSettled({ failed: false });
    expect(rig.reported.map(([, state]) => state)).toEqual(["reading", "working", "done"]);
  });
});

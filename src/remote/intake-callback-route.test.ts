// Flow 403, AC18: a button press in the service topic "Intake" reaches the intake handler, a press in a
// session topic goes to the session as before, and a press from outside the allowlist reaches neither.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type CallbackDelivery, INTAKE_EARLY_ACK_MS, INTAKE_EARLY_ACK_TEXT, INTAKE_HANDLER_TIMEOUT_MS, type IntakeCallbackHandler, type IntakeCallbackPress } from "./hub";
import { remoteDirPath } from "./paths";
import { INTAKE_SERVICE_TOPIC, isIntakeCallbackData } from "./protocol";
import { type Harness, makeHarness, OWNER_ID, STRANGER_ID, until } from "./remote.test-helpers";

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

const DATA = "in:c0ffee12:ack";

function journalLines(): { ts: string; userId: number | null }[] {
  try {
    return readFileSync(path.join(remoteDirPath(h.dir), "rejected.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { ts: string; userId: number | null });
  } catch {
    return [];
  }
}

async function setup(handler?: IntakeCallbackHandler) {
  h = makeHarness();
  const sessionCallbacks: CallbackDelivery[] = [];
  const hub = h.makeHub({ deliverCallback: async (_id, callback) => void sessionCallbacks.push(callback) });
  const presses: IntakeCallbackPress[] = [];
  hub.registerIntakeCallbackHandler(
    handler ??
      (async (press) => {
        presses.push(press);
        return { text: "Taken" };
      }),
  );
  const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
  if (!reg.ok) throw new Error("register failed");
  await hub.start();
  let cardMessageId = -1;
  const sent = await hub.sendToServiceTopic(INTAKE_SERVICE_TOPIC, "New ticket", {
    keyboard: [[{ text: "Ack", callback_data: DATA }]],
    onSent: (info) => {
      cardMessageId = info.messageId;
    },
  });
  if (!sent.ok) throw new Error("service topic send failed");
  await until(() => cardMessageId > 0, "card sent");
  return { hub, reg, presses, sessionCallbacks, intakeThread: sent.threadId, cardMessageId };
}

describe("intake callback route", () => {
  test("a press from the Intake topic reaches the intake handler and is answered with its reply", async () => {
    const { presses, sessionCallbacks, intakeThread, cardMessageId } = await setup();
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => presses.length === 1, "handler call");
    expect(presses[0]).toMatchObject({ chatId: h.api.chatId, threadId: intakeThread, messageId: cardMessageId, fromId: OWNER_ID, data: DATA });
    await until(() => h.api.answeredCallbacks.length === 1, "answer");
    expect(h.api.answeredCallbacks[0]?.text).toBe("Taken");
    expect(sessionCallbacks).toEqual([]);
  });

  test("an approval-style press in a session topic still reaches the session, not intake", async () => {
    const { reg, presses, sessionCallbacks } = await setup();
    h.api.pushCallback({ fromId: OWNER_ID, data: "approve:yes", threadId: reg.threadId });
    await until(() => sessionCallbacks.length === 1, "session callback");
    expect(sessionCallbacks[0]?.data).toBe("approve:yes");
    expect(h.api.answeredCallbacks).toHaveLength(1);
    expect(presses).toEqual([]);
  });

  test("a press from outside the allowlist reaches no handler, is unanswered and journaled by id and time only", async () => {
    const { presses, sessionCallbacks, intakeThread, cardMessageId } = await setup();
    h.api.pushCallback({ fromId: STRANGER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => journalLines().length === 1, "journal line");
    await until(() => h.api.pendingUpdates().length === 0, "update consumed");
    expect(presses).toEqual([]);
    expect(sessionCallbacks).toEqual([]);
    expect(h.api.answeredCallbacks).toEqual([]);
    const [entry] = journalLines();
    expect(Object.keys(entry ?? {}).sort()).toEqual(["ts", "userId"]);
    expect(entry?.userId).toBe(STRANGER_ID);
    expect(JSON.stringify(readFileSync(path.join(remoteDirPath(h.dir), "rejected.jsonl"), "utf8"))).not.toContain("c0ffee12");
  });

  test("a press from another chat is not handed to intake", async () => {
    const { presses, intakeThread, cardMessageId } = await setup();
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId, chatId: -100999 });
    await until(() => h.api.pendingUpdates().length === 0, "update consumed");
    expect(presses).toEqual([]);
  });

  test("data outside the intake namespace or past 64 bytes is not handed to intake, but is acknowledged", async () => {
    const { presses, intakeThread, cardMessageId } = await setup();
    h.api.pushCallback({ fromId: OWNER_ID, data: "approve:yes", threadId: intakeThread, messageId: cardMessageId });
    h.api.pushCallback({ fromId: OWNER_ID, data: `in:${"x".repeat(62)}`, threadId: intakeThread, messageId: cardMessageId });
    await until(() => h.api.answeredCallbacks.length === 2, "both answered");
    expect(presses).toEqual([]);
    expect(isIntakeCallbackData(DATA)).toBe(true);
    expect(isIntakeCallbackData(`in:${"x".repeat(62)}`)).toBe(false);
  });

  test("a throwing handler still answers the press, with no text", async () => {
    const { hub, intakeThread, cardMessageId } = await setup(async () => {
      throw new Error("registry unreadable");
    });
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => h.api.answeredCallbacks.length === 1, "answer");
    expect(h.api.answeredCallbacks[0]?.text).toBeUndefined();
    expect(hub.events().some((event) => event.type === "delivery-failed")).toBe(true);
  });

  test("with no handler registered a press is acknowledged and dropped", async () => {
    const { hub, intakeThread, cardMessageId } = await setup();
    hub.registerIntakeCallbackHandler(undefined);
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => h.api.answeredCallbacks.length === 1, "answer");
    expect(hub.events().some((event) => event.type === "update-unrouted" && /no handler/.test(event.detail ?? ""))).toBe(true);
  });
});

describe("a press from another service topic is not an intake press", () => {
  test("it reaches no handler, is logged as unrouted and the button is still answered", async () => {
    const { hub, presses, sessionCallbacks } = await setup();
    let otherMessageId = -1;
    const other = await hub.sendToServiceTopic("Digest", "Another service", {
      keyboard: [[{ text: "Ack", callback_data: DATA }]],
      onSent: (info) => {
        otherMessageId = info.messageId;
      },
    });
    if (!other.ok) throw new Error("second service topic send failed");
    await until(() => otherMessageId > 0, "second card sent");
    expect(other.threadId).not.toBe(undefined);
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: other.threadId, messageId: otherMessageId });
    await until(() => h.api.answeredCallbacks.length === 1, "answer");
    expect(presses).toEqual([]);
    expect(sessionCallbacks).toEqual([]);
    expect(hub.events().some((event) => event.type === "update-unrouted" && /no session in topic/.test(event.detail ?? ""))).toBe(true);
  });
});

describe("a slow intake press is answered early, and its result still arrives (S7)", () => {
  function gate() {
    let open: (reply: Awaited<ReturnType<IntakeCallbackHandler>>) => void = () => undefined;
    const done = new Promise<Awaited<ReturnType<IntakeCallbackHandler>>>((resolve) => {
      open = resolve;
    });
    return { done, open };
  }

  test("a handler that is still running after the early window gets a short ack, then a follow-up with its text", async () => {
    const g = gate();
    let started = false;
    const { hub, intakeThread, cardMessageId } = await setup(async () => {
      started = true;
      return g.done;
    });
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => started, "handler started");
    expect(h.api.answeredCallbacks).toEqual([]);
    await h.clock.advance(INTAKE_EARLY_ACK_MS);
    await until(() => h.api.answeredCallbacks.length === 1, "early ack");
    expect(h.api.answeredCallbacks[0]?.text).toBe(INTAKE_EARLY_ACK_TEXT);
    g.open({ text: "Взято в работу: flow 412" });
    await until(() => h.api.sent.some((m) => m.text.includes("flow 412")), "follow-up");
    expect(h.api.answeredCallbacks).toHaveLength(1);
    expect(hub.events().some((event) => event.type === "delivery-failed")).toBe(false);
  });

  test("a result the handler already put on the card is not posted a second time", async () => {
    const g = gate();
    let started = false;
    const { hub, intakeThread, cardMessageId } = await setup(async () => {
      started = true;
      return g.done;
    });
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => started, "handler started");
    await h.clock.advance(INTAKE_EARLY_ACK_MS);
    await until(() => h.api.answeredCallbacks.length === 1, "early ack");
    g.open({ text: "уже на карточке", edited: true });
    // A positive fence: a message sent after the handler finished is on the topic, and the result text is not.
    // Yielding one macrotask lets the hub's continuation run first, so a bad re-post would be queued before the fence.
    await Bun.sleep(0);
    const fence = await hub.sendToServiceTopic(INTAKE_SERVICE_TOPIC, "fence");
    expect(fence.ok).toBe(true);
    await until(() => h.api.sent.some((m) => m.text === "fence"), "fence sent");
    expect(h.api.sent.some((m) => m.text.includes("уже на карточке"))).toBe(false);
  });

  test("a fast handler is answered with its own text and never with the early ack", async () => {
    const { intakeThread, cardMessageId } = await setup(async () => ({ text: "Taken" }));
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => h.api.answeredCallbacks.length === 1, "answer");
    await h.clock.advance(INTAKE_EARLY_ACK_MS * 2);
    expect(h.api.answeredCallbacks.map((a) => a.text)).toEqual(["Taken"]);
  });

  test("a handler that never finishes is cut off, logged, and the button was answered", async () => {
    let started = false;
    const { hub, intakeThread, cardMessageId } = await setup(async () => {
      started = true;
      return new Promise<undefined>(() => undefined);
    });
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => started, "handler started");
    await h.clock.advance(INTAKE_HANDLER_TIMEOUT_MS);
    await until(() => hub.events().some((event) => event.type === "delivery-failed" && /did not finish/.test(event.detail ?? "")), "timeout event");
    expect(h.api.answeredCallbacks.map((a) => a.text)).toEqual([INTAKE_EARLY_ACK_TEXT]);
  });

  test("a handler that finishes after the hard timeout still has its result posted to the topic", async () => {
    const g = gate();
    let started = false;
    const { intakeThread, cardMessageId, hub } = await setup(async () => {
      started = true;
      return g.done;
    });
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => started, "handler started");
    await h.clock.advance(INTAKE_HANDLER_TIMEOUT_MS);
    await until(() => hub.events().some((event) => event.type === "delivery-failed" && /did not finish/.test(event.detail ?? "")), "timeout event");
    expect(h.api.sent.some((m) => m.text.includes("flow 412"))).toBe(false);
    g.open({ text: "Взято в работу: flow 412" });
    await until(() => h.api.sent.some((m) => m.text.includes("flow 412")), "late result");
  });

  test("a late result the handler already put on the card is not posted after the hard timeout either", async () => {
    const g = gate();
    let started = false;
    const { intakeThread, cardMessageId, hub } = await setup(async () => {
      started = true;
      return g.done;
    });
    h.api.pushCallback({ fromId: OWNER_ID, data: DATA, threadId: intakeThread, messageId: cardMessageId });
    await until(() => started, "handler started");
    await h.clock.advance(INTAKE_HANDLER_TIMEOUT_MS);
    await until(() => hub.events().some((event) => event.type === "delivery-failed" && /did not finish/.test(event.detail ?? "")), "timeout event");
    g.open({ text: "уже на карточке", edited: true });
    await Bun.sleep(0);
    const fence = await hub.sendToServiceTopic(INTAKE_SERVICE_TOPIC, "fence");
    expect(fence.ok).toBe(true);
    await until(() => h.api.sent.some((m) => m.text === "fence"), "fence sent");
    expect(h.api.sent.some((m) => m.text.includes("уже на карточке"))).toBe(false);
  });
});

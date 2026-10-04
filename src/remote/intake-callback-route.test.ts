// Flow 403, AC18: a button press in the service topic "Intake" reaches the intake handler, a press in a
// session topic goes to the session as before, and a press from outside the allowlist reaches neither.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CallbackDelivery, IntakeCallbackPress } from "./hub";
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

async function setup(handler?: (press: IntakeCallbackPress) => Promise<{ text?: string } | undefined>) {
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

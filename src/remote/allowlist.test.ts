// AC8: only allowlisted Telegram user ids are routed. Everyone else is dropped
// before any queue, with a journal line holding the user id and the time and
// nothing else. Button presses obey the same list.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CallbackDelivery } from "./hub";
import { RejectedJournal } from "./journal";
import { remoteDirPath } from "./paths";
import { type Harness, fileMode, makeHarness, OWNER_ID, STRANGER_ID, until } from "./remote.test-helpers";

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

function journalLines(): { ts: string; userId: number | null }[] {
  const file = path.join(remoteDirPath(h.dir), "rejected.jsonl");
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { ts: string; userId: number | null });
  } catch {
    return [];
  }
}

async function setup(options: { allowed?: number[] } = {}) {
  h = makeHarness({ config: { allowedUserIds: options.allowed ?? [OWNER_ID] } });
  const callbacks: CallbackDelivery[] = [];
  const hub = h.makeHub({
    deliverCallback: async (_sessionId, callback) => {
      callbacks.push(callback);
    },
  });
  const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
  if (!reg.ok) throw new Error("register failed");
  await hub.start();
  return { hub, reg, callbacks };
}

describe("allowlist", () => {
  test("an allowed user's line is delivered; a stranger's line in the same topic is not", async () => {
    const { reg } = await setup();
    h.api.pushMessage({ fromId: STRANGER_ID, text: "rm -rf everything", threadId: reg.threadId });
    h.api.pushMessage({ fromId: OWNER_ID, text: "status please", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "owner delivery");
    await until(() => h.api.pendingUpdates().length === 0, "both updates consumed");
    expect(h.deliveries.map((d) => d.line)).toEqual(["status please"]);
  });

  test("the journal records the stranger's id and time, and never what they wrote", async () => {
    const { reg } = await setup();
    h.api.pushMessage({ fromId: STRANGER_ID, text: "SECRET-PAYLOAD-12345", threadId: reg.threadId });
    await until(() => journalLines().length === 1, "journal line");

    const [entry] = journalLines();
    expect(Object.keys(entry ?? {}).sort()).toEqual(["ts", "userId"]);
    expect(entry?.userId).toBe(STRANGER_ID);
    expect(entry?.ts).toBe(new Date(h.clock.now()).toISOString());

    const raw = readFileSync(path.join(remoteDirPath(h.dir), "rejected.jsonl"), "utf8");
    expect(raw).not.toContain("SECRET-PAYLOAD");
    expect(fileMode(path.join(remoteDirPath(h.dir), "rejected.jsonl"))).toBe(0o600);
  });

  test("a refused sender leaves nothing in any queue and no trace in events beyond the id", async () => {
    const { hub, reg } = await setup();
    h.api.pushMessage({ fromId: STRANGER_ID, text: "PAYLOAD-IN-EVENT", threadId: reg.threadId });
    await until(() => hub.events().some((e) => e.type === "sender-refused"), "refusal event");
    expect(JSON.stringify(hub.events())).not.toContain("PAYLOAD-IN-EVENT");
    expect(h.deliveries).toEqual([]);
    expect(hub.outboundPending()).toBe(0);
  });

  test("a stranger's button press is dropped, unanswered, and journaled", async () => {
    const { reg, callbacks } = await setup();
    h.api.pushCallback({ fromId: STRANGER_ID, data: "approve:yes", threadId: reg.threadId });
    await until(() => journalLines().length === 1, "journal line");
    await until(() => h.api.pendingUpdates().length === 0, "update consumed");
    expect(callbacks).toEqual([]);
    expect(h.api.answeredCallbacks).toEqual([]);
    expect(journalLines()[0]?.userId).toBe(STRANGER_ID);
  });

  test("an allowed user's button press is answered and delivered with its data", async () => {
    const { reg, callbacks } = await setup();
    h.api.pushCallback({ fromId: OWNER_ID, data: "approve:yes", threadId: reg.threadId });
    await until(() => callbacks.length === 1, "callback delivery");
    expect(callbacks[0]?.data).toBe("approve:yes");
    expect(callbacks[0]?.fromId).toBe(OWNER_ID);
    expect(h.api.answeredCallbacks).toHaveLength(1);
    expect(journalLines()).toEqual([]);
  });

  test("an update with no sender id is refused and journaled with a null user", async () => {
    const { hub, reg } = await setup();
    await hub.receive([
      {
        update_id: 9_001,
        message: { message_id: 1, message_thread_id: reg.threadId, chat: { id: h.api.chatId }, date: 0, text: "anonymous" },
      },
    ]);
    expect(h.deliveries).toEqual([]);
    expect(journalLines()).toHaveLength(1);
    expect(journalLines()[0]?.userId).toBeNull();
  });

  test("an allowed user writing from another chat is ignored, not journaled", async () => {
    const { reg } = await setup();
    h.api.pushMessage({ fromId: OWNER_ID, text: "wrong room", threadId: reg.threadId, chatId: -100999 });
    await until(() => h.api.pendingUpdates().length === 0, "update consumed");
    expect(h.deliveries).toEqual([]);
    expect(journalLines()).toEqual([]);
  });

  test("an allowed user writing in the general topic or an unbound topic is ignored", async () => {
    await setup();
    h.api.pushMessage({ fromId: OWNER_ID, text: "general chatter" });
    h.api.pushMessage({ fromId: OWNER_ID, text: "dead topic", threadId: 99_999 });
    await until(() => h.api.pendingUpdates().length === 0, "updates consumed");
    expect(h.deliveries).toEqual([]);
  });

  test("an empty allowlist routes nothing (the config loader refuses it, and the hub still holds the line)", async () => {
    const { reg } = await setup({ allowed: [] });
    h.api.pushMessage({ fromId: OWNER_ID, text: "hello", threadId: reg.threadId });
    await until(() => journalLines().length === 1, "journal line");
    expect(h.deliveries).toEqual([]);
  });

  test("each allowlisted id is accepted, not just the first", async () => {
    const { reg } = await setup({ allowed: [OWNER_ID, 5150] });
    h.api.pushMessage({ fromId: 5150, text: "second operator", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "delivery");
    expect(h.deliveries[0]?.meta.fromId).toBe(5150);
  });

  test("the journal line is exactly {ts, userId}", () => {
    h = makeHarness();
    const journal = new RejectedJournal({ dir: h.dir, now: h.clock.now });
    journal.record(31337);
    const raw = readFileSync(journal.path, "utf8").trim();
    expect(JSON.parse(raw)).toEqual({ ts: new Date(h.clock.now()).toISOString(), userId: 31337 });
  });
});

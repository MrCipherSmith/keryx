// AC1: a session registers, gets a topic, exchanges messages with it, and the
// topic is archived (a closing note, closed, history kept) when the session deregisters.

import { afterEach, describe, expect, test } from "bun:test";
import { SESSION_LEASE_HEARTBEAT_MS } from "../session/lease";
import { type Harness, makeHarness, OWNER_ID, STALE_MS, until } from "./remote.test-helpers";

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

describe("remote session lifecycle", () => {
  test("register creates one topic named after the project and the session", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const result = await hub.register({ sessionId: "abcdef12-3456-7890", project: "/work/billing-api" });
    expect(result).toEqual({ ok: true, name: "billing-api-abcdef12", threadId: expect.any(Number), reused: false });
    expect(h.api.topics().map((topic) => topic.name)).toEqual(["billing-api-abcdef12"]);
    expect(hub.list().map((entry) => [entry.name, entry.status])).toEqual([["billing-api-abcdef12", "live"]]);
  });

  test("a line typed in the topic reaches the session and is confirmed to Telegram", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/work/app" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();

    h.api.pushMessage({ fromId: OWNER_ID, text: "run the tests", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "delivery");

    expect(h.deliveries[0]?.sessionId).toBe("sess-one-0001");
    expect(h.deliveries[0]?.line).toBe("run the tests");
    expect(h.deliveries[0]?.meta.threadId).toBe(reg.threadId);
    // The next poll carries the advanced offset, so Telegram forgets the update.
    await until(() => h.api.pendingUpdates().length === 0, "offset confirmed");
  });

  test("text for the session is posted into its own topic only", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const a = await hub.register({ sessionId: "sess-aaaa-0001", project: "/work/app", name: "alpha" });
    const b = await hub.register({ sessionId: "sess-bbbb-0002", project: "/work/app", name: "beta" });
    if (!a.ok || !b.ok) throw new Error("register failed");
    expect(await hub.send("sess-aaaa-0001", "build finished")).toBe(true);
    expect(h.api.sentTo(a.threadId).map((m) => m.text)).toContain("build finished");
    expect(h.api.sentTo(b.threadId).map((m) => m.text)).not.toContain("build finished");
    expect(await hub.send("unknown-session", "nobody home")).toBe(false);
  });

  test("deregister archives the topic with a closing note and later messages in it are ignored", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/work/app" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();

    expect(await hub.deregister("sess-one-0001")).toEqual({ ok: true, existed: true });
    expect(h.api.topics().map((t) => t.messageThreadId)).toEqual([reg.threadId]);
    expect(h.api.deletedTopics).toEqual([]);
    expect(h.api.closedTopics.map((t) => t.messageThreadId)).toEqual([reg.threadId]);
    expect(h.api.sentTo(reg.threadId).map((m) => m.text).some((t) => /history stays here/i.test(t))).toBe(true);
    expect(hub.list()).toEqual([]);

    h.api.pushMessage({ fromId: OWNER_ID, text: "anyone?", threadId: reg.threadId });
    await until(() => h.api.pendingUpdates().length === 0, "update consumed");
    expect(h.deliveries).toEqual([]);
    expect(await hub.deregister("sess-one-0001")).toEqual({ ok: true, existed: false });
  });

  test("flow 419 AC7: topic and history survive a shell that exits and a shell that is killed with Ctrl+C", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const exits = await hub.register({ sessionId: "sess-exit-0001", project: "/work/app", name: "exits" });
    const killed = await hub.register({ sessionId: "sess-kill-0002", project: "/work/app", name: "killed" });
    if (!exits.ok || !killed.ok) throw new Error("register failed");
    await hub.start();
    await hub.send("sess-exit-0001", "first reply");
    await hub.send("sess-kill-0002", "second reply");

    // An orderly exit deregisters. A Ctrl+C sends nothing: serve only notices the silence.
    await hub.deregister("sess-exit-0001");
    await h.clock.advance(STALE_MS);
    await h.clock.advance(10 * 60_000 + SESSION_LEASE_HEARTBEAT_MS);
    await until(() => h.api.closedTopics.length === 2, "both topics archived");

    expect(h.api.deletedTopics).toEqual([]);
    for (const thread of [exits.threadId, killed.threadId]) {
      expect(h.api.topic(thread)).toBeDefined();
      expect(h.api.sentTo(thread).some((m) => /history stays here/i.test(m.text))).toBe(true);
    }
    expect(h.api.sentTo(exits.threadId).map((m) => m.text)).toContain("first reply");
    expect(h.api.sentTo(killed.threadId).map((m) => m.text)).toContain("second reply");
  });

  test("a heartbeat from an unregistered session is refused with a reason", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const result = await hub.heartbeat("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown-session");
    }
  });

  test("registering twice with the same session is idempotent: one topic", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const first = await hub.register({ sessionId: "sess-one-0001", project: "/work/app" });
    const second = await hub.register({ sessionId: "sess-one-0001", project: "/work/app" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.threadId).toBe(first.threadId);
    }
    expect(h.api.topics()).toHaveLength(1);
  });

  test("a topic that cannot be created leaves nothing registered", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    h.api.setDown(true);
    const result = await hub.register({ sessionId: "sess-one-0001", project: "/work/app" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("api-error");
    }
    expect(hub.list()).toEqual([]);
  });

  test("a message that cannot be delivered stays queued and is retried until taken", async () => {
    h = makeHarness();
    const hub = h.makeHub({ deliverRetryMs: 1_000 });
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/work/app" });
    if (!reg.ok) throw new Error("register failed");
    h.refuseDeliveries = true;
    await hub.start();
    h.api.pushMessage({ fromId: OWNER_ID, text: "please retry", threadId: reg.threadId });
    await until(() => hub.events().some((e) => e.type === "delivery-failed"), "first failed delivery");
    expect(h.deliveries).toEqual([]);

    h.refuseDeliveries = false;
    await h.clock.advance(1_000);
    await until(() => h.deliveries.length === 1, "redelivery");
    expect(h.deliveries[0]?.line).toBe("please retry");
  });
});

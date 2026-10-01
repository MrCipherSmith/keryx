// AC6: orphaned sessions. A shell that stops heartbeating is announced as
// unavailable in its topic; the topic is deleted after the orphan timeout; the
// same name returning before then takes the topic back.

import { afterEach, describe, expect, test } from "bun:test";
import { SESSION_LEASE_HEARTBEAT_MS } from "../session/lease";
import type { RemoteHub } from "./hub";
import { BotApiError } from "./types";
import { type Harness, makeHarness, OWNER_ID, STALE_MS, until } from "./remote.test-helpers";

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

const ORPHAN_MS = 10 * 60_000;

async function keepAlive(hub: RemoteHub, sessionId: string, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += SESSION_LEASE_HEARTBEAT_MS) {
    await h.clock.advance(SESSION_LEASE_HEARTBEAT_MS);
    await hub.heartbeat(sessionId);
  }
}

function texts(threadId: number): string[] {
  return h.api.sentTo(threadId).map((m) => m.text);
}

describe("orphaned sessions", () => {
  test("a silent session is announced, kept for the orphan timeout, then its topic is deleted", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();

    await h.clock.advance(STALE_MS);
    await until(() => hub.list()[0]?.status === "unavailable", "marked unavailable");
    await until(() => texts(reg.threadId).some((t) => /session unavailable/i.test(t)), "unavailable notice");
    expect(h.api.topic(reg.threadId)).toBeDefined();

    await h.clock.advance(ORPHAN_MS - SESSION_LEASE_HEARTBEAT_MS);
    expect(h.api.topic(reg.threadId)).toBeDefined();

    await h.clock.advance(SESSION_LEASE_HEARTBEAT_MS);
    await until(() => h.api.topic(reg.threadId) === undefined, "topic deleted");
    expect(hub.list()).toEqual([]);
    expect(h.api.deletedTopics).toHaveLength(1);
  });

  test("the notice says how long the topic is kept", async () => {
    h = makeHarness({ config: { orphanMs: 2 * 60_000 } });
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();
    await h.clock.advance(STALE_MS);
    await until(() => texts(reg.threadId).some((t) => /unavailable/i.test(t)), "notice");
    expect(texts(reg.threadId).find((t) => /unavailable/i.test(t))).toContain("2 minutes");
  });

  test("the orphan timeout is configurable", async () => {
    h = makeHarness({ config: { orphanMs: 30_000 } });
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();
    await h.clock.advance(STALE_MS + 30_000);
    await until(() => h.api.topic(reg.threadId) === undefined, "topic deleted after 30 s");
  });

  test("a heartbeat inside the window brings the session back and cancels deletion", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();
    await h.clock.advance(STALE_MS + 60_000);
    expect(hub.list()[0]?.status).toBe("unavailable");

    const back = await hub.heartbeat("sess-one-0001");
    expect(back.ok).toBe(true);
    expect(hub.list()[0]?.status).toBe("live");
    await until(() => texts(reg.threadId).some((t) => /available again/i.test(t)), "return notice");

    await keepAlive(hub, "sess-one-0001", ORPHAN_MS + 60_000);
    expect(h.api.topic(reg.threadId)).toBeDefined();
    expect(h.api.deletedTopics).toEqual([]);
  });

  test("the same name returning with a new session reuses the stored topic", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const first = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!first.ok) throw new Error("register failed");
    await hub.start();
    await h.clock.advance(STALE_MS + 120_000);
    expect(hub.list()[0]?.status).toBe("unavailable");

    const again = await hub.register({ sessionId: "sess-two-0002", project: "/w/app", name: "release" });
    expect(again).toEqual({ ok: true, name: "release", threadId: first.threadId, reused: true });
    expect(h.api.topics()).toHaveLength(1);
    expect(h.api.deletedTopics).toEqual([]);

    await keepAlive(hub, "sess-two-0002", ORPHAN_MS + 60_000);
    expect(h.api.topic(first.threadId)).toBeDefined();
  });

  test("after the topic is gone, the same name gets a fresh topic", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const first = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!first.ok) throw new Error("register failed");
    await hub.start();
    await h.clock.advance(STALE_MS + ORPHAN_MS + SESSION_LEASE_HEARTBEAT_MS);
    await until(() => h.api.topic(first.threadId) === undefined, "topic deleted");

    const again = await hub.register({ sessionId: "sess-two-0002", project: "/w/app", name: "release" });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.threadId).not.toBe(first.threadId);
      expect(again.reused).toBe(false);
    }
  });

  test("words typed while the session is away wait and are delivered when it returns", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();
    await h.clock.advance(STALE_MS);
    await until(() => hub.list()[0]?.status === "unavailable", "unavailable");

    h.api.pushMessage({ fromId: OWNER_ID, text: "are you there", threadId: reg.threadId });
    await until(() => h.api.pendingUpdates().length === 0, "update persisted and confirmed");
    expect(h.deliveries).toEqual([]);

    await hub.heartbeat("sess-one-0001");
    await until(() => h.deliveries.length === 1, "delivery after return");
    expect(h.deliveries[0]?.line).toBe("are you there");
  });

  test("a topic that cannot be deleted right now is retried by the next sweep", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();
    h.api.failNext("deleteForumTopic", new BotApiError("network", "deleteForumTopic: request failed"));

    await h.clock.advance(STALE_MS + ORPHAN_MS);
    await until(() => hub.events().some((e) => e.type === "topic-delete-failed"), "failed deletion");
    expect(h.api.topic(reg.threadId)).toBeDefined();

    await h.clock.advance(SESSION_LEASE_HEARTBEAT_MS);
    await until(() => h.api.topic(reg.threadId) === undefined, "retried deletion");
    expect(hub.list()).toEqual([]);
  });

  test("a clock that jumps back does not orphan a live session, nor keep a dead one forever", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();

    h.clock.set(h.clock.now() - 60 * 60_000);
    await h.clock.advance(SESSION_LEASE_HEARTBEAT_MS);
    expect(hub.list()[0]?.status).toBe("live");

    await h.clock.advance(STALE_MS + SESSION_LEASE_HEARTBEAT_MS);
    expect(hub.list()[0]?.status).toBe("unavailable");
  });

  test("a heartbeat stamped slightly in the future counts as fresh", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();
    h.clock.set(h.clock.now() - 3_000);
    await h.clock.advance(SESSION_LEASE_HEARTBEAT_MS);
    expect(hub.list()[0]?.status).toBe("live");
  });
});

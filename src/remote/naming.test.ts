// AC2: topic names. Default `<project>-<short session id>`; an explicit name is
// honored; a name held by a live session is refused; a dead or expired holder's
// name is taken over and keeps its topic.

import { afterEach, describe, expect, test } from "bun:test";
import { checkName, defaultName, defaultNameCandidates, nameKey } from "./naming";
import { type Harness, makeHarness, STALE_MS } from "./remote.test-helpers";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("name rules", () => {
  test("the default name is the project folder and the first 8 characters of the id", () => {
    expect(defaultName("/home/me/work/My App", "ab12-cd34-ef56")).toBe("My-App-ab12cd34");
    expect(defaultName("/", "x")).toBe("project-x");
  });

  test("candidates grow with the id so two sessions with a shared prefix can still be told apart", () => {
    const names = [...defaultNameCandidates("/w/app", "abcd1234efgh5678ijkl")];
    expect(names[0]).toBe("app-abcd1234");
    expect(names[1]).toBe("app-abcd1234efgh");
    expect(names.at(-1)).toBe("app-abcd1234efgh5678ijkl");
  });

  test("names compare without case or surrounding space", () => {
    expect(nameKey("  Release ")).toBe(nameKey("release"));
  });

  test("an operator-chosen name must be 1 to 128 printable characters", () => {
    expect(checkName("  my   topic ")).toEqual({ ok: true, name: "my topic" });
    expect(checkName("   ").ok).toBe(false);
    expect(checkName("x".repeat(129)).ok).toBe(false);
    expect(checkName("bad\u0007name").ok).toBe(false);
  });
});

describe("name ownership", () => {
  test("a name held by a live session is refused and creates nothing", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const first = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "Release" });
    expect(first.ok).toBe(true);
    const topicsBefore = h.api.topics().length;

    const second = await hub.register({ sessionId: "sess-two-0002", project: "/w/app", name: "release" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("name-taken");
    }
    expect(h.api.topics().length).toBe(topicsBefore);
    expect(hub.list().map((s) => s.sessionId)).toEqual(["sess-one-0001"]);
  });

  test("a stale holder's name is taken over and the topic is reused, not recreated", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const first = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!first.ok) throw new Error("register failed");
    await h.clock.advance(STALE_MS + 1);

    const second = await hub.register({ sessionId: "sess-two-0002", project: "/w/app", name: "release" });
    expect(second).toEqual({ ok: true, name: "release", threadId: first.threadId, reused: true });
    expect(h.api.topics()).toHaveLength(1);
    expect(hub.list().map((s) => s.sessionId)).toEqual(["sess-two-0002"]);
  });

  test("a heartbeat keeps a name live past the staleness bound", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    await h.clock.advance(STALE_MS - 1_000);
    await hub.heartbeat("sess-one-0001");
    await h.clock.advance(STALE_MS - 1_000);
    const rival = await hub.register({ sessionId: "sess-two-0002", project: "/w/app", name: "release" });
    expect(rival.ok).toBe(false);
  });

  test("two default names that collide on the short id fall through to a longer one", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const a = await hub.register({ sessionId: "abcd1234-aaaa-0000", project: "/w/app" });
    const b = await hub.register({ sessionId: "abcd1234-bbbb-0000", project: "/w/app" });
    if (!a.ok || !b.ok) throw new Error("register failed");
    expect(a.name).toBe("app-abcd1234");
    expect(b.name).not.toBe(a.name);
    expect(b.name.startsWith("app-abcd1234")).toBe(true);
    expect(h.api.topics()).toHaveLength(2);
  });

  test("an invalid explicit name is refused before any topic is created", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const result = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "x".repeat(200) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-name");
    }
    expect(h.api.topics()).toEqual([]);
  });

  test("a session renaming itself leaves its old topic and gets one under the new name", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const first = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "old" });
    const second = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "new" });
    if (!first.ok || !second.ok) throw new Error("register failed");
    expect(second.threadId).not.toBe(first.threadId);
    expect(h.api.topics().map((t) => t.name)).toEqual(["new"]);
  });
});

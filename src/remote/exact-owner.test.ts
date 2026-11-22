import { afterEach, expect, test } from "bun:test";
import { makeHarness, type Harness } from "./remote.test-helpers";

let h: Harness;
afterEach(async () => { await h.cleanup(); });

const owner = { kind: "desktop" as const, incarnation: "owner1", generation: "gen1" };

test("desktop reconnects only to its exact topic and cannot transfer either direction", async () => {
  h = makeHarness();
  const hub = h.makeHub();
  const first = await hub.register({ sessionId: "desktop1", project: "/w/app", name: "desktop", owner });
  if (!first.ok) throw new Error("registration failed");
  expect(await hub.register({ sessionId: "desktop1", project: "/w/app", name: "desktop", owner, expectedThreadId: first.threadId })).toEqual({ ...first, reused: true });
  expect((await hub.register({ sessionId: "desktop1", project: "/w/app", owner: { ...owner, generation: "gen2" } })).ok).toBe(false);
  expect((await hub.register({ sessionId: "desktop1", project: "/w/app" })).ok).toBe(false);
  expect((await hub.register({ sessionId: "terminal", project: "/w/app", name: "desktop" })).ok).toBe(false);
  expect((await hub.register({ sessionId: "desktop1", project: "/w/app", owner, expectedThreadId: first.threadId + 1 })).ok).toBe(false);
  expect(hub.matchesOwner("desktop1", undefined)).toBe(false);
  expect(hub.matchesOwner("desktop1", owner)).toBe(true);
  const terminal = await hub.register({ sessionId: "terminal", project: "/w/app", name: "terminal" });
  expect(terminal.ok).toBe(true);
  expect((await hub.register({ sessionId: "other", project: "/w/app", name: "terminal", owner })).ok).toBe(false);
});

test("HTTP rejects terminal and older generation access to a Desktop binding", async () => {
  const { makeRig, call } = await import("./remote.http.test-helpers");
  const rig = makeRig();
  try {
    const serve = await rig.startServe();
    const client = rig.makeClient({ sessionId: "desktop2", project: "/w/app", name: "desktop2", owner, onLine: () => {} });
    const started = await client.start();
    expect(started.ok).toBe(true);
    for (const route of ["heartbeat", "reply", "deregister", "approval", "approval-result", "approval-ack", "prompt", "prompt-close", "state", "ack"]) {
      const result = await call(serve.origin, serve.shellToken, "POST", `/v1/remote/${route}`, { sessionId: "desktop2", text: "wrong owner" });
      expect(result.status).toBe(404);
    }
    const stale = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/heartbeat", { sessionId: "desktop2", owner: { ...owner, generation: "gen2" } });
    expect(stale.status).toBe(404);
    const stream = await call(serve.origin, serve.shellToken, "GET", "/v1/remote/stream?sessionId=desktop2");
    expect(stream.status).toBe(404);
    const encodedOwner = encodeURIComponent(JSON.stringify(owner));
    const duplicate = await call(serve.origin, serve.shellToken, "GET", `/v1/remote/stream?sessionId=desktop2&owner=${encodedOwner}&owner=${encodedOwner}`);
    expect(duplicate.status).toBe(400);
    const oversized = await call(serve.origin, serve.shellToken, "POST", "/v1/remote/reply", { sessionId: "desktop2", owner, text: "x".repeat(70_000) });
    expect(oversized.status).toBe(413);
    expect(await client.reply("correct owner")).toBe(true);
  } finally {
    await rig.cleanup();
  }
});

test("only the exact Desktop owner gets a valid private-supergroup topic link", async () => {
  h = makeHarness({ config: { chatId: -1001234567890 } });
  const hub = h.makeHub();
  const result = await hub.register({ sessionId: "desktop-link", project: "/w/app", name: "desktop-link", owner });
  if (!result.ok) throw new Error("registration failed");
  expect(hub.topicUrl("desktop-link", owner)).toBe(`https://t.me/c/1234567890/${result.threadId}`);
  expect(hub.topicUrl("desktop-link", { ...owner, generation: "gen2" })).toBeUndefined();
});

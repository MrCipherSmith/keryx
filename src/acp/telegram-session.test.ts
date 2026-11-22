import { expect, test } from "bun:test";
import { parseTelegramSessionRequest, unavailableTelegramSession } from "./telegram-session";

test("session control accepts only the closed request contract", () => {
  expect(parseTelegramSessionRequest({ operation: "attach", sessionId: "s1", topicName: "work" })).toEqual({ operation: "attach", sessionId: "s1", topicName: "work" });
  expect(parseTelegramSessionRequest({ operation: "status", sessionId: "s1" })).toEqual({ operation: "status", sessionId: "s1" });
  expect(parseTelegramSessionRequest({ operation: "detach", sessionId: "s1", topicName: "work" })).toBeUndefined();
  expect(parseTelegramSessionRequest({ operation: "attach", sessionId: "s1", owner: "forged" })).toBeUndefined();
  expect(parseTelegramSessionRequest({ operation: "attach", sessionId: "" })).toBeUndefined();
  expect(parseTelegramSessionRequest({ operation: "attach", sessionId: "s1", topicName: "x".repeat(101) })).toBeUndefined();
});

test("unfinished delegation is reported unavailable", () => {
  expect(unavailableTelegramSession("s1")).toEqual({ sessionId: "s1", state: "unavailable", reason: "capability-unavailable" });
});

test("binding coalesces attach and refuses a stale hold without creating a client", async () => {
  const { TelegramSessionBindings } = await import("./telegram-session");
  const lease = {};
  let valid = true;
  let created = 0;
  let resolveStart!: (value: { ok: true; threadId: number }) => void;
  const start = new Promise<{ ok: true; threadId: number }>((resolve) => { resolveStart = resolve; });
  let closed = 0;
  const manager = new TelegramSessionBindings({
    held: () => ({ project: "/project", lease }), owns: () => valid,
    onStop: () => false, onInput: async () => "accepted", incarnation: "owner1", generation: () => "gen1",
    create: (input) => { created++; expect(input.owner).toEqual({ kind: "desktop", incarnation: "owner1", generation: "gen1" }); return { start: () => start, close: async () => { closed++; }, reply: async () => true }; },
  });
  const first = manager.attach("s1");
  const second = manager.attach("s1");
  expect(first).toBe(second);
  expect(created).toBe(1);
  valid = false;
  resolveStart({ ok: true, threadId: 1 });
  expect(await first).toEqual({ sessionId: "s1", state: "unavailable", reason: "lease-lost" });
  expect(closed).toBe(1);
  expect(await manager.attach("s1")).toEqual({ sessionId: "s1", state: "unavailable", reason: "lease-lost" });
  expect(created).toBe(1);
});

test("late attachment cannot overwrite a newer generation after detach", async () => {
  const { TelegramSessionBindings } = await import("./telegram-session");
  const lease = {};
  let resolveFirst!: (value: { ok: true; threadId: number }) => void;
  const firstStart = new Promise<{ ok: true; threadId: number }>((resolve) => { resolveFirst = resolve; });
  let generations = 0;
  const states: string[] = [];
  const manager = new TelegramSessionBindings({ held: () => ({ project: "/project", lease }), owns: () => true,
    onStop: () => false, onInput: async () => "accepted", incarnation: "owner1", generation: () => `gen${++generations}`,
    create: () => ({ start: () => generations === 1 ? firstStart : Promise.resolve({ ok: true, threadId: 2 }), close: async () => {}, reply: async () => true }),
    onState: (state) => states.push(state.state),
  });
  const old = manager.attach("s1");
  await manager.detach("s1");
  expect(await manager.attach("s1")).toEqual({ sessionId: "s1", state: "active" });
  resolveFirst({ ok: true, threadId: 1 });
  await old;
  expect(manager.status("s1")).toEqual({ sessionId: "s1", state: "active" });
  expect(states).toEqual(["attaching", "detached", "attaching", "active"]);
});

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

test("disconnect closes admission and exact reconnect reopens it", async () => {
  const { TelegramSessionBindings } = await import("./telegram-session");
  const lease = {};
  let status!: (value: import("../remote/client").ClientStatus) => void;
  let input!: (text: string, meta: import("../remote/client").InboundMeta) => Promise<void>;
  let admitted = 0;
  let stopped = 0;
  const manager = new TelegramSessionBindings({
    held: () => ({ project: "/project", lease }), owns: () => true,
    incarnation: "owner1", generation: () => "generation1", onStop: () => { stopped++; return true; },
    onInput: async () => { admitted++; return "accepted"; },
    create: (args) => { status = args.onStatus; input = args.onLine; return { start: async () => ({ ok: true, threadId: 123 }), close: async () => {}, reply: async () => true }; },
  });
  await manager.attach("s1");
  const meta = { updateId: 1, threadId: 123, fromId: 42, receivedAt: 0 };
  status({ state: "disconnected" });
  expect(manager.status("s1").state).toBe("reconnecting");
  await input("ignore", meta);
  expect(admitted).toBe(0);
  expect(stopped).toBe(0);
  status({ state: "connected" });
  expect(manager.status("s1").state).toBe("active");
  await input("accept", { ...meta, updateId: 2 });
  expect(admitted).toBe(1);
});

test("channel revocation invalidates the exact generation before returning acknowledgement", async () => {
  const { TelegramSessionBindings } = await import("./telegram-session");
  const lease = {};
  let revoke!: (id: string) => boolean;
  let stop = 0;
  const manager = new TelegramSessionBindings({ held: () => ({ project: "/project", lease }), owns: () => true,
    incarnation: "owner1", generation: () => "gen1", onStop: () => { stop++; return true; }, onInput: async () => "accepted",
    create: (input) => { revoke = input.onChannelRevoked; return { start: async () => ({ ok: true, threadId: 1 }), close: async () => {}, reply: async () => true }; },
  });
  await manager.attach("s1");
  expect(revoke("cutover")).toBe(true);
  expect(manager.currentGeneration("s1")).toBeUndefined();
  expect(manager.status("s1").state).toBe("detached");
  expect(stop).toBe(1);
  expect(revoke("cutover")).toBe(false);
});

test("status is scoped to the bound session and does not start a turn", async () => {
  const { TelegramSessionBindings } = await import("./telegram-session");
  const lease = {};
  let input!: (text: string, meta: import("../remote/client").InboundMeta) => Promise<void>;
  const replies: string[] = [];
  let admitted = 0;
  const manager = new TelegramSessionBindings({ held: () => ({ project: "/project", lease }), owns: () => true,
    incarnation: "owner1", generation: () => "gen1", onStop: () => false, isBusy: () => true,
    onInput: async () => { admitted++; return "accepted"; },
    create: (args) => { input = args.onLine; return { start: async () => ({ ok: true, threadId: 1, topicUrl: "https://t.me/c/123/1" }), close: async () => {}, reply: async (text) => { replies.push(text); return true; } }; },
  });
  expect(await manager.attach("s1")).toEqual({ sessionId: "s1", state: "active", topicUrl: "https://t.me/c/123/1" });
  await input("/status", { updateId: 1, threadId: 1, fromId: 42, receivedAt: 0 });
  expect(replies).toEqual(["Connected. A turn is running."]);
  expect(admitted).toBe(0);
});

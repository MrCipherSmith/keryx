import { expect, test } from "bun:test";
import { ForwardingBotApi } from "./forwarding-bot-api";
import { FakeBotApi } from "./fake-bot-api";
import { makeHarness, until } from "./remote.test-helpers";
import { BotApiError } from "./types";

test("forwarding API preserves its reference and optional capabilities", async () => {
  const first = new FakeBotApi({ botId: 123 });
  const second = new FakeBotApi({ botId: 456 });
  const forwarding = new ForwardingBotApi(first);
  const stable = forwarding.api;
  expect((await stable.getMe()).id).toBe(123);
  forwarding.replace(second);
  expect(forwarding.api).toBe(stable);
  expect((await stable.getMe()).id).toBe(456);
});

test("failed candidate is stopped before the original poller is restored", async () => {
  const h = makeHarness();
  try {
    const hub = h.makeHub({ pollTimeoutSec: 0 });
    await hub.start();
    expect(await hub.waitForPollerReady(1000)).toBe(true);
    const initial = await hub.register({ sessionId: "session-handoff", project: "project", name: "handoff" });
    expect(initial.ok).toBe(true);
    const originalCount = hub.list().length;
    const candidate = new FakeBotApi();
    let originalActiveDuringCandidate = -1;
    candidate.getUpdates = async () => {
      originalActiveDuringCandidate = h.api.activePollers();
      throw new BotApiError("conflict", "fixture conflict");
    };
    expect(await hub.handoffPoller(candidate, 1000)).toEqual({ ok: false, recovered: true });
    expect(originalActiveDuringCandidate).toBe(0);
    expect(hub.list().length).toBe(originalCount);
    expect(hub.pollerStatus().state).toBe("running");
    await until(() => h.api.callCount("getUpdates", "default") >= 2, "original poller restored");
  } finally { await h.cleanup(); }
});

test("successful handoff keeps the hub and forwards later sends to the candidate", async () => {
  const h = makeHarness();
  try {
    const hub = h.makeHub({ pollTimeoutSec: 0 });
    await hub.start();
    expect(await hub.waitForPollerReady(1000)).toBe(true);
    const before = await hub.register({ sessionId: "session-rotation", project: "project", name: "rotation" });
    expect(before.ok).toBe(true);
    const candidate = new FakeBotApi();
    expect(await hub.handoffPoller(candidate, 1000)).toEqual({ ok: true });
    expect(hub.list()).toHaveLength(1);
    await hub.sendGeneral("after rotation");
    expect(candidate.callCount("sendMessage", "default")).toBeGreaterThan(0);
    expect(h.api.activePollers()).toBe(0);
  } finally { await h.cleanup(); }
});

test("a refused commit keeps new sends fenced until original recovery", async () => {
  const h = makeHarness();
  try {
    const hub = h.makeHub({ pollTimeoutSec: 0 });
    await hub.start();
    expect(await hub.waitForPollerReady(1000)).toBe(true);
    const candidate = new FakeBotApi();
    let release: ((value: boolean) => void) | undefined;
    let entered = false;
    const changing = hub.handoffPoller(candidate, 1000, () => { entered = true; return new Promise((resolve) => { release = resolve; }); });
    await until(() => entered, "commit hook");
    const send = hub.sendGeneral("queued during cutover");
    expect(h.api.callCount("sendMessage", "default")).toBe(0);
    expect(candidate.callCount("sendMessage", "default")).toBe(0);
    release?.(false);
    expect(await changing).toEqual({ ok: false, recovered: true });
    await send;
    expect(h.api.callCount("sendMessage", "default")).toBe(1);
    expect(candidate.callCount("sendMessage", "default")).toBe(0);
  } finally { await h.cleanup(); }
});

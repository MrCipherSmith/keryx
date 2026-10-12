import { expect, test } from "bun:test";
import { createShellFinalizer } from "./shell-finalizer";
test("signals and renderer destruction share one barrier", async () => {
  const seen: string[] = [];
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const finalize = createShellFinalizer({
    stop: () => { seen.push("stop"); }, checkpoint: () => { seen.push("checkpoint"); },
    preserve: async () => { seen.push("preserve"); await blocked; },
    cleanup: async () => { seen.push("cleanup"); }, release: () => { seen.push("release"); }, progress: () => {},
  });
  const first = finalize();
  expect(finalize()).toBe(first);
  await Promise.resolve(); await Promise.resolve();
  expect(seen).not.toContain("release");
  unblock();
  expect(await first).toEqual({ preserved: true, cleanupFailed: false });
  expect(seen).toEqual(["stop", "checkpoint", "preserve", "cleanup", "release"]);
  expect(finalize()).toBe(first);
});
test("failed checkpoint never reports queued; cleanup still runs", async () => {
  const stages: string[] = [];
  let released = false;
  const finalize = createShellFinalizer({
    stop: () => {}, checkpoint: () => { throw new Error("sensitive disk error"); },
    preserve: async () => { throw new Error("must not execute"); }, cleanup: async () => { throw new Error("cleanup failed"); },
    release: () => { released = true; }, progress: (stage) => { stages.push(stage); },
  });
  expect(await finalize()).toEqual({ preserved: false, cleanupFailed: true });
  expect(released).toBe(true);
  expect(stages).toEqual(["saving", "failed", "released"]);
});
test("broken terminal output cannot bypass preservation", async () => {
  const finalize = createShellFinalizer({ stop: () => {}, checkpoint: () => {}, preserve: async () => {},
    cleanup: async () => {}, release: () => {}, progress: () => { throw new Error("EPIPE"); }, });
  expect((await finalize()).preserved).toBe(true);
});

test("optional cleanup cannot hang ownership release", async () => {
  let released = false;
  const finalize = createShellFinalizer({ stop: () => {}, checkpoint: () => {}, preserve: async () => {},
    cleanup: () => new Promise<void>(() => {}), cleanupTimeoutMs: 5,
    release: () => { released = true; }, progress: () => {}, });
  expect(await finalize()).toEqual({ preserved: true, cleanupFailed: true });
  expect(released).toBe(true);
});

test("stalled delivery releases ownership after durable intent is saved", async () => {
  const seen: string[] = [];
  const finalize = createShellFinalizer({
    stop: () => { seen.push("stop"); },
    checkpoint: () => { seen.push("checkpoint"); },
    preserve: async () => { seen.push("durable-intent"); },
    cleanup: () => { seen.push("delivery"); return new Promise<void>(() => {}); },
    cleanupTimeoutMs: 5,
    release: () => { seen.push("release"); },
    progress: () => {},
  });
  expect(await finalize()).toEqual({ preserved: true, cleanupFailed: true });
  expect(seen).toEqual(["stop", "checkpoint", "durable-intent", "delivery", "release"]);
});


test("checkpoint waits for active turn settlement", async () => {
  const seen: string[] = [];
  let settle: () => void = () => {};
  const pending = new Promise<void>((resolve) => { settle = resolve; });
  const finalize = createShellFinalizer({
    stop: async () => { seen.push("abort"); await pending; seen.push("settled"); },
    checkpoint: () => { seen.push("checkpoint"); }, preserve: async () => {},
    cleanup: async () => {}, release: () => { seen.push("release"); }, progress: () => {},
  });
  const result = finalize();
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(seen).toEqual(["abort"]);
  settle();
  expect((await result).preserved).toBe(true);
  expect(seen).toEqual(["abort", "settled", "checkpoint", "release"]);
});

test("stop deadline checkpoints partial state but retains ownership until settlement", async () => {
  const seen: string[] = [];
  let settle!: () => void;
  const pending = new Promise<void>(resolve => { settle = resolve; });
  const finalize = createShellFinalizer({
    stop: () => pending, stopTimeoutMs: 5,
    checkpoint: () => { seen.push("checkpoint"); }, preserve: async () => { seen.push("preserve"); },
    cleanup: async () => {}, release: () => { seen.push("release"); }, progress: stage => { seen.push(stage); },
  });
  let done = false;
  const result = finalize().then(value => { done = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(done).toBe(false);
  expect(seen).toEqual(["saving", "waiting", "checkpoint"]);
  settle();
  expect((await result).preserved).toBe(true);
  expect(seen).toEqual(["saving", "waiting", "checkpoint", "checkpoint", "preserve", "queued", "release", "released"]);
});


test("cleanup timeout aborts late side effects before releasing ownership", async () => {
  const seen: string[] = [];
  let settle: () => void = () => {};
  const pending = new Promise<void>(resolve => { settle = resolve; });
  const finalize = createShellFinalizer({
    stop: () => {}, checkpoint: () => {}, preserve: async () => {},
    cleanup: async signal => { await pending; signal.throwIfAborted(); seen.push("late-write"); },
    cleanupTimeoutMs: 5, release: () => { seen.push("release"); }, progress: () => {},
  });
  expect(await finalize()).toEqual({ preserved: true, cleanupFailed: true });
  settle();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(seen).toEqual(["release"]);
});

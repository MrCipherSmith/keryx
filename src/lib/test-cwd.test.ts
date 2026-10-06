import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCwd } from "./test-cwd";

test("withCwd restores cwd after a successful asynchronous callback", async () => {
  const previous = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "keryx-cwd-success-"));
  try {
    const result = await withCwd(dir, async () => {
      await Promise.resolve();
      expect(process.cwd()).toBe(await realpath(dir));
      return 42;
    });
    expect(result).toBe(42);
    expect(process.cwd()).toBe(previous);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withCwd restores cwd after rejection and keeps the queue usable", async () => {
  const previous = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "keryx-cwd-failure-"));
  try {
    await expect(withCwd(dir, async () => {
      await Promise.resolve();
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");
    expect(process.cwd()).toBe(previous);
    await withCwd(dir, async () => expect(process.cwd()).not.toBe(previous));
    expect(process.cwd()).toBe(previous);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withCwd serializes queued callbacks and restores the original cwd", async () => {
  const previous = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "keryx-cwd-queue-"));
  const events: string[] = [];
  try {
    await Promise.all([
      withCwd(dir, async () => {
        events.push("first:start");
        await Promise.resolve();
        events.push("first:end");
      }),
      withCwd(previous, async () => {
        expect(process.cwd()).toBe(previous);
        events.push("second");
      }),
    ]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(process.cwd()).toBe(previous);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withCwd rejects a missing directory without changing cwd", async () => {
  const previous = process.cwd();
  const missing = join(previous, `missing-cwd-${crypto.randomUUID()}`);
  await expect(withCwd(missing, async () => undefined)).rejects.toThrow();
  expect(process.cwd()).toBe(previous);
});

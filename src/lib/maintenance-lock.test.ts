// Flow 290 T5/T10 (AC9, AC10): the shared maintenance lock — re-entrant within
// one async context, exclusive across unrelated contexts and processes.
//
// Every overlap below is REAL and ordered by events (a promise the holder
// resolves once it is inside, a marker file a child writes), never by sleeping
// and hoping two things overlapped.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  holdsMaintenanceLock,
  MAINTENANCE_LOCK_BUSY_EXIT_CODE,
  MaintenanceLockBusyError,
  maintenanceLockPath,
  runInteractiveUnderMaintenanceLock,
  withMaintenanceLock,
} from "./maintenance-lock";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-maint-lock-"));
});

afterEach(async () => {
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("AC10: a nested acquire in the holder's own async context runs straight through (no self-refusal, no wait)", async () => {
  const order: string[] = [];
  await withMaintenanceLock(
    root,
    async () => {
      order.push("outer");
      expect(holdsMaintenanceLock(root)).toBe(true);
      // `waitMs: 0` — any self-contention would throw at once instead of waiting.
      await withMaintenanceLock(
        root,
        async () => {
          order.push("inner");
          // And a third level, the shape of trigger reconcile -> sync --apply -> gdgraph build.
          await withMaintenanceLock(root, async () => {
            order.push("innermost");
          }, { waitMs: 0 });
        },
        { waitMs: 0 },
      );
    },
    { waitMs: 0 },
  );
  expect(order).toEqual(["outer", "inner", "innermost"]);
  expect(holdsMaintenanceLock(root)).toBe(false);
});

test("AC10: two unrelated concurrent acquires in ONE process still exclude each other", async () => {
  const inside = deferred();
  const release = deferred();
  const first = withMaintenanceLock(
    root,
    async () => {
      inside.resolve();
      await release.promise;
      return "first";
    },
    { waitMs: 0 },
  );
  await inside.promise;
  // A sibling async context (not nested in `first`'s callback) must NOT be
  // treated as re-entrant: it is refused, and the holder's pid is named.
  let caught: unknown;
  try {
    await withMaintenanceLock(root, async () => "second", { waitMs: 0 });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaintenanceLockBusyError);
  expect((caught as MaintenanceLockBusyError).holderPid).toBe(process.pid);
  expect((caught as MaintenanceLockBusyError).message).toContain(`pid ${process.pid}`);
  release.resolve();
  expect(await first).toBe("first");
  // Released: the next acquire succeeds.
  expect(await withMaintenanceLock(root, async () => "third", { waitMs: 0 })).toBe("third");
});

test("a waiting acquire gets the lock once the holder releases it (bounded wait, not a refusal)", async () => {
  const inside = deferred();
  const release = deferred();
  const order: string[] = [];
  const first = withMaintenanceLock(
    root,
    async () => {
      inside.resolve();
      await release.promise;
      order.push("first-done");
    },
    { waitMs: 0 },
  );
  await inside.promise;
  const second = withMaintenanceLock(
    root,
    async () => {
      order.push("second-ran");
    },
    { waitMs: 60_000 },
  );
  release.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["first-done", "second-ran"]);
});

test("an error thrown by the locked work is not mistaken for contention", async () => {
  await expect(
    withMaintenanceLock(
      root,
      async () => {
        throw new Error("Timed out waiting for lock: some OTHER lock the work took");
      },
      { waitMs: 0 },
    ),
  ).rejects.toThrow("some OTHER lock");
});

test("AC9: an interactive caller that finds the lock held past its wait says who holds it and exits 75 — not a build failure", async () => {
  const inside = deferred();
  const release = deferred();
  const holder = withMaintenanceLock(
    root,
    async () => {
      inside.resolve();
      await release.promise;
    },
    { waitMs: 0 },
  );
  await inside.promise;
  const previous = process.env["KERYX_MAINTENANCE_LOCK_WAIT_MS"];
  process.env["KERYX_MAINTENANCE_LOCK_WAIT_MS"] = "0";
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  let ran = false;
  try {
    const result = await runInteractiveUnderMaintenanceLock(root, "gdgraph build", async () => {
      ran = true;
    });
    expect(result).toBe(false);
  } finally {
    console.error = realError;
    if (previous === undefined) delete process.env["KERYX_MAINTENANCE_LOCK_WAIT_MS"];
    else process.env["KERYX_MAINTENANCE_LOCK_WAIT_MS"] = previous;
    release.resolve();
    await holder;
  }
  expect(ran).toBe(false);
  expect(process.exitCode).toBe(MAINTENANCE_LOCK_BUSY_EXIT_CODE);
  expect(lines.join("\n")).toContain("keryx gdgraph build: not run");
  expect(lines.join("\n")).toContain(`pid ${process.pid}`);
  expect(lines.join("\n")).toContain(maintenanceLockPath(root));
  expect(lines.join("\n")).not.toContain("failed");
});

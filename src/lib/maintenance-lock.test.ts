// Flow 290 T5/T10 (AC9, AC10): the shared maintenance lock — re-entrant within
// one async context, exclusive across unrelated contexts and processes.
//
// Every overlap below is REAL and ordered by events (a promise the holder
// resolves once it is inside, a marker file a child writes), never by sleeping
// and hoping two things overlapped.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  holdsMaintenanceLock,
  keryxLocksDir,
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

// ---------------------------------------------------------------------------
// Flow 290 T13 (review item 7)
// ---------------------------------------------------------------------------

test("the held lock is never committed: `git add -A` while it is held stages nothing under .locks", async () => {
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "a.txt"), "a\n");
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
  try {
    expect(maintenanceLockPath(root).startsWith(keryxLocksDir(root))).toBe(true);
    // The lock directory really exists right now…
    expect(await readFile(path.join(maintenanceLockPath(root), "owner.json"), "utf8")).toContain(String(process.pid));
    execFileSync("git", ["add", "-A"], { cwd: root });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root }).toString();
    // …and still nothing of it is staged.
    expect(staged.trim()).toBe("a.txt");
  } finally {
    release.resolve();
    await holder;
  }
});

test("work scheduled inside the locked callback that runs after release is not treated as holding the lock", async () => {
  const fired = deferred();
  const released = deferred();
  let heldInTimer: boolean | undefined;
  let staleReentry: string | undefined;
  await withMaintenanceLock(
    root,
    async () => {
      // Registered INSIDE the callback (so it carries this async context) and
      // run only once the lock has been released — an event, not a delay.
      void released.promise.then(() => {
        heldInTimer = holdsMaintenanceLock(root);
        // A stale context must go to the file lock, not straight through: with
        // another holder present it is refused.
        const other = deferred();
        const otherRelease = deferred();
        const otherHolder = withMaintenanceLock(
          root,
          async () => {
            other.resolve();
            await otherRelease.promise;
          },
          { waitMs: 0 },
        );
        void other.promise.then(async () => {
          try {
            await withMaintenanceLock(root, async () => undefined, { waitMs: 0 });
            staleReentry = "ran straight through";
          } catch (error) {
            staleReentry = error instanceof MaintenanceLockBusyError ? "refused" : String(error);
          }
          otherRelease.resolve();
          await otherHolder;
          fired.resolve();
        });
      });
    },
    { waitMs: 0 },
  );
  released.resolve();
  await fired.promise;
  expect(heldInTimer).toBe(false);
  expect(staleReentry).toBe("refused");
});

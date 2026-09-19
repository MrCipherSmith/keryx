// Review r1 F3 (flow 272): two waiters reclaiming the same dead holder's lock.
//
// Reclaimer A judges the lock stale, then — before it moves the lock aside —
// reclaimer B reclaims it, takes a fresh lock and is inside its critical
// section. A's rename must not move B's live lock away: exactly one holder at
// a time. The interleaving is injected through `withFileLock`'s race hook, so
// nothing depends on timing.

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withFileLock } from "./fs";

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

/** A pid that is certainly not running. */
const DEAD_PID = 2 ** 22 + 12345;

test("two reclaimers racing over a dead owner never both hold the lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-lock-reclaim-"));
  ROOTS.push(dir);
  const lockPath = path.join(dir, "the.lock");
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: DEAD_PID, token: "dead-owner" }), "utf8");
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(lockPath, old, old);

  let inside = 0;
  let maxInside = 0;
  const critical = async (hold: Promise<void>): Promise<void> => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await hold;
    inside -= 1;
  };

  let releaseB!: () => void;
  const bHolds = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let bEntered!: () => void;
  const bInside = new Promise<void>((resolve) => {
    bEntered = resolve;
  });
  let bDone: Promise<void> | undefined;

  const options = { staleMs: 1_000, retryMs: 5, timeoutMs: 10_000 };
  const aDone = withFileLock(lockPath, () => critical(Promise.resolve()), {
    ...options,
    raceHook: async () => {
      if (bDone !== undefined) return; // only the first judgement races
      // B reclaims the same stale lock and is inside its critical section
      // before A acts on its (now outdated) judgement.
      bDone = withFileLock(lockPath, async () => {
        bEntered();
        await critical(bHolds);
      }, options);
      await bInside;
    },
  });

  // Let A act on its stale judgement while B still holds the lock.
  await Bun.sleep(50);
  expect(inside).toBe(1);
  releaseB();
  await Promise.all([aDone, bDone]);

  expect(maxInside).toBe(1);
  // B's lock was put back, not deleted and not left aside.
  expect((await readdir(dir)).filter((name) => name.includes(".stale."))).toEqual([]);
});

// Review r2 N2: a third acquirer C whose `mkdir` lands between reclaimer B's
// rename-aside of A's live lock and B's rename-back. The rename-back replaces
// C's still-empty directory with A's lock; C's owner write then fails, and C
// must NOT clean up by deleting `lockPath` — that is A's live lock now.
test("an acquirer caught mid-creation by a rename-back never deletes the restored lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-lock-rename-back-"));
  ROOTS.push(dir);
  const lockPath = path.join(dir, "the.lock");
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: DEAD_PID, token: "dead-owner" }), "utf8");
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(lockPath, old, old);

  let inside = 0;
  let maxInside = 0;
  const holders: string[] = [];
  const critical = async (name: string, hold: Promise<void>): Promise<void> => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    holders.push(name);
    await hold;
    inside -= 1;
  };
  const signal = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const aInside = signal();
  const aRelease = signal();
  const cCreated = signal();
  const bRestored = signal();
  const options = { staleMs: 1_000, retryMs: 5, timeoutMs: 10_000 };

  let aDone: Promise<void> | undefined;
  let cDone: Promise<void> | undefined;
  let ownerAfterRestore: string | undefined;
  const bDone = withFileLock(lockPath, () => critical("B", Promise.resolve()), {
    ...options,
    raceHook: async (point) => {
      if (point === "stale-judged" && aDone === undefined) {
        // A reclaims the dead lock and holds it before B acts on its judgement.
        aDone = withFileLock(lockPath, async () => {
          aInside.resolve();
          await critical("A", aRelease.promise);
        }, options);
        await aInside.promise;
      }
      if (point === "moved-aside" && cDone === undefined) {
        // B has moved A's live lock aside: C's mkdir lands on the empty path.
        cDone = withFileLock(lockPath, () => critical("C", Promise.resolve()), {
          ...options,
          raceHook: async (at) => {
            if (at !== "created") return;
            cCreated.resolve();
            await bRestored.promise; // C writes its owner only after B's rename-back
          },
        });
        await cCreated.promise;
      }
      if (point === "restored" && !ownerAfterRestore) {
        ownerAfterRestore = await readFile(path.join(lockPath, "owner.json"), "utf8").catch(() => "missing");
        bRestored.resolve();
      }
    },
  });

  await bRestored.promise;
  // Let C act on its failed owner write while A still holds the lock.
  await Bun.sleep(50);
  expect(await readFile(path.join(lockPath, "owner.json"), "utf8").catch(() => "missing")).toBe(ownerAfterRestore as string);
  expect(inside).toBe(1);
  aRelease.resolve();
  await Promise.all([aDone, bDone, cDone]);

  expect(maxInside).toBe(1);
  expect(holders.sort()).toEqual(["A", "B", "C"]);
});

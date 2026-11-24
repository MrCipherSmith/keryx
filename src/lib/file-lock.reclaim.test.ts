// Flow 520 T16 B4: two waiters reclaiming the same stale lock file.
//
// Waiter A judges the lock stale; before it acts on that judgement, waiter B breaks the same stale lock and takes a fresh
// one. A must not remove B's live lock and enter as well: exactly one holder at a time. The interleaving is injected
// through `withFileLock`'s race hook (the same seam shape as `src/lib/fs.lock-reclaim.test.ts`), so nothing depends on
// timing.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withFileLock, withFileLockAsync } from "./file-lock";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-file-lock-reclaim-"));
  lockPath = path.join(dir, "the.lock");
  writeFileSync(lockPath, "dead-holder");
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(lockPath, old, old);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a waiter whose stale judgement is outdated never removes the fresh lock another waiter took", () => {
  let entered = false;
  let raced = false;
  const result = withFileLock(lockPath, () => {
    entered = true;
    return "A";
  }, {
    staleMs: 1_000,
    timeoutMs: 200,
    raceHook: (point) => {
      if (point !== "stale-judged" || raced) return;
      raced = true;
      // B breaks the dead holder's lock and holds a fresh one before A acts on its judgement.
      rmSync(lockPath);
      writeFileSync(lockPath, "holder-B");
    },
  });
  expect(raced).toBe(true);
  // A waited for B (who never released here) and gave up; it never ran alongside B.
  expect(entered).toBe(false);
  expect(result).toBeNull();
  expect(readFileSync(lockPath, "utf8")).toBe("holder-B");
  expect(readdirSync(dir).filter((name) => name.includes(".aside."))).toEqual([]);
});

test("a fresh lock that reuses the stale lock's inode is still recognised as fresh", () => {
  // Linux gives a just-freed inode number to the next file created, so on CI waiter B's fresh lock usually carries the
  // dead lock's inode. Rewriting the same file in place reproduces that on every platform: same dev and ino, new mtime.
  let entered = false;
  let raced = false;
  const result = withFileLock(lockPath, () => {
    entered = true;
    return "A";
  }, {
    staleMs: 1_000,
    timeoutMs: 200,
    raceHook: (point) => {
      if (point !== "stale-judged" || raced) return;
      raced = true;
      writeFileSync(lockPath, "holder-B");
    },
  });
  expect(raced).toBe(true);
  expect(entered).toBe(false);
  expect(result).toBeNull();
  expect(readFileSync(lockPath, "utf8")).toBe("holder-B");
  expect(readdirSync(dir).filter((name) => name.includes(".aside."))).toEqual([]);
});

test("the asynchronous wait keeps the same rule for a fresh lock on the stale lock's inode", async () => {
  let entered = false;
  let raced = false;
  const result = await withFileLockAsync(lockPath, () => {
    entered = true;
    return "A";
  }, {
    staleMs: 1_000,
    timeoutMs: 200,
    raceHook: (point) => {
      if (point !== "stale-judged" || raced) return;
      raced = true;
      writeFileSync(lockPath, "holder-B");
    },
  });
  expect(raced).toBe(true);
  expect(entered).toBe(false);
  expect(result).toBeNull();
  expect(readFileSync(lockPath, "utf8")).toBe("holder-B");
  expect(readdirSync(dir).filter((name) => name.includes(".aside."))).toEqual([]);
});

test("a stale lock nobody else touched is still reclaimed and released", () => {
  expect(withFileLock(lockPath, () => "ran", { staleMs: 1_000, timeoutMs: 2_000 })).toBe("ran");
  expect(existsSync(lockPath)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test("a fresh lock is waited on, never broken", () => {
  writeFileSync(lockPath, "live-holder");
  expect(withFileLock(lockPath, () => "ran", { staleMs: 10_000, timeoutMs: 100 })).toBeNull();
  expect(readFileSync(lockPath, "utf8")).toBe("live-holder");
});

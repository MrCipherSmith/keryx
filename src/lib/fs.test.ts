// RED tests for flow 165 (Slate Phase 5), Track A item 1: `isLockHeld` +
// `DEFAULT_LOCK_STALE_MS` in `src/lib/fs.ts`, next to `withFileLock`.
//
// Neither export exists yet — this whole file fails at IMPORT time until
// task-implementer adds them, mirroring the RED-file convention already used
// by `slate-terminal-state.test.ts`/`agent.test.ts`'s SLATE-11 block ("the
// missing-export import is the expected RED failure for the WHOLE file, not
// a per-test bug").
//
// PINNED API (plan.md Track A item 1 / flow 165 AC5):
//   export const DEFAULT_LOCK_STALE_MS = 30000;
//   export async function isLockHeld(lockPath: string, staleMs = DEFAULT_LOCK_STALE_MS): Promise<boolean>;
// Mirrors `removeStaleLock`'s own staleness rule (fs.ts:96-108) exactly, but
// READ-ONLY — it must never mkdir/rename/rm the lock directory, unlike
// `removeStaleLock`'s reclaim path:
//   - stat(lockPath) ENOENT or any read failure -> false (not held).
//   - Date.now() - stats.mtimeMs <= staleMs -> true (held, unconditionally —
//     an owner file is not even consulted while the lock is still fresh; this
//     is what keeps the narrow mkdir/writeFile(owner.json) acquisition window
//     from ever reading as "not held").
//   - Otherwise (older than staleMs): held iff the recorded owner pid
//     (owner.json, `{pid, token}`) is alive. No owner file / unreadable /
//     dead pid -> false.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_LOCK_STALE_MS, isLockHeld, withFileLock } from "./fs";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-fs-lock-"));
}

/**
 * Directly construct a lock directory in the exact on-disk shape
 * `withFileLock`'s own `mkdir(lockPath)` + `writeFile(ownerPath, ...)`
 * produces (fs.ts:56-63) — `isLockHeld` must read this shape without going
 * through `withFileLock` itself (which would release the lock again before
 * this test could observe it as held).
 */
async function plantLockDir(
  lockPath: string,
  opts: { owner?: { pid: number; token: string }; ageMs?: number } = {},
): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  if (opts.owner !== undefined) {
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(opts.owner), { mode: 0o600 });
  }
  if (opts.ageMs !== undefined) {
    const aged = new Date(Date.now() - opts.ageMs);
    await utimes(lockPath, aged, aged);
  }
}

/** A pid that was real a moment ago and is now guaranteed dead. */
async function definitelyDeadPid(): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

test("DEFAULT_LOCK_STALE_MS is the single source of truth for the 30s threshold — the SAME value withFileLock's own inline default already used, not a second hardcoded literal", () => {
  expect(DEFAULT_LOCK_STALE_MS).toBe(30000);
});

test("isLockHeld: a fresh-mtime lock (younger than staleMs) counts as held even with no owner.json yet — the narrow mkdir/writeFile(owner.json) acquisition window must never read as 'not held'", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  await plantLockDir(lockPath); // no owner.json, fresh mtime (just created)
  await expect(isLockHeld(lockPath)).resolves.toBe(true);
});

test("isLockHeld: a fresh-mtime lock counts as held unconditionally, even with a DEAD owner pid recorded — age alone decides while still under staleMs", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  const deadPid = await definitelyDeadPid();
  await plantLockDir(lockPath, { owner: { pid: deadPid, token: "t" } }); // fresh mtime
  await expect(isLockHeld(lockPath)).resolves.toBe(true);
});

test("isLockHeld: a stale (older-than-staleMs) lock with a DEAD owner pid is NOT held", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  const deadPid = await definitelyDeadPid();
  await plantLockDir(lockPath, { owner: { pid: deadPid, token: "t" }, ageMs: DEFAULT_LOCK_STALE_MS + 5_000 });
  await expect(isLockHeld(lockPath)).resolves.toBe(false);
});

test("isLockHeld: a stale (older-than-staleMs) lock whose owner pid is STILL ALIVE is still held — mirrors removeStaleLock's aliveness-wins-over-age rule", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  await plantLockDir(lockPath, { owner: { pid: process.pid, token: "t" }, ageMs: DEFAULT_LOCK_STALE_MS + 5_000 });
  await expect(isLockHeld(lockPath)).resolves.toBe(true);
});

test("isLockHeld: a stale lock with NO owner.json (missing/unreadable) is not held — 'no owner info' is treated as not verifiably alive once past staleMs", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  await plantLockDir(lockPath, { ageMs: DEFAULT_LOCK_STALE_MS + 5_000 }); // no owner.json at all
  await expect(isLockHeld(lockPath)).resolves.toBe(false);
});

test("isLockHeld: no lock directory at all (never acquired / already released) is not held", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  await expect(isLockHeld(lockPath)).resolves.toBe(false);
});

test("isLockHeld: a stat failure (e.g. a path component that is a plain file, not a directory) degrades to not-held rather than throwing", async () => {
  const dir = await tempDir();
  const notADirectory = path.join(dir, "not-a-directory");
  await writeFile(notADirectory, "plain file, not a directory");
  // `notADirectory` is a plain file — a lock path nested inside it can never
  // stat successfully (ENOTDIR), unlike a lock path that is itself a plain
  // file (stat succeeds on files too, so that alone would not exercise the
  // read-failure branch).
  const lockPath = path.join(notADirectory, "slate.json.lock");
  await expect(isLockHeld(lockPath)).resolves.toBe(false);
});

test("isLockHeld never mutates or removes the lock directory — read-only by contract, unlike removeStaleLock's own stale-lock reclaim", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  const deadPid = await definitelyDeadPid();
  await plantLockDir(lockPath, { owner: { pid: deadPid, token: "t" }, ageMs: DEFAULT_LOCK_STALE_MS + 5_000 });

  await isLockHeld(lockPath);

  // The lock dir (and its owner.json) must still be present, byte-identical —
  // removeStaleLock's own reclaim would have renamed-then-rm'd it by now.
  await expect(stat(lockPath)).resolves.toBeDefined();
  await expect(readFile(path.join(lockPath, "owner.json"), "utf8")).resolves.toContain(String(deadPid));
});

test("isLockHeld honors a caller-supplied staleMs override instead of DEFAULT_LOCK_STALE_MS", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  const deadPid = await definitelyDeadPid();
  // Aged past a tiny custom staleMs (100ms) but nowhere near the real default.
  await plantLockDir(lockPath, { owner: { pid: deadPid, token: "t" }, ageMs: 500 });
  await expect(isLockHeld(lockPath, 100)).resolves.toBe(false);
  // The SAME on-disk lock, under the real (much larger) default staleMs, is
  // still "fresh enough" and reported held.
  await expect(isLockHeld(lockPath)).resolves.toBe(true);
});

test("isLockHeld integration: a lock genuinely held by withFileLock is reported held while the callback runs, and not-held once it returns", async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, "slate.json.lock");
  let observedDuringHold: boolean | undefined;
  await withFileLock(lockPath, async () => {
    observedDuringHold = await isLockHeld(lockPath);
  });
  expect(observedDuringHold).toBe(true);
  await expect(isLockHeld(lockPath)).resolves.toBe(false);
});

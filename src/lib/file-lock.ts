// One exclusive-lock helper for the user-global config directory.
//
// Extracted verbatim from `withRegistryLock` in `src/lib/project-registry.ts`
// (flow 127), which is where its behaviour was worked out over several review
// rounds — the nonce, the deadline checked before the stale branch, and the
// "only remove the lock if it is still ours" rule each closed a real defect.
//
// It moved here because `keryx serve` needs the same serialization for its
// credential store: `issue` is a check-then-write, and two concurrent
// `keryx serve token issue` runs each printed a token to their operator while
// only the last one to write actually worked. A second copy of a lock this
// subtle would be a second place to get it wrong.
//
// Atomic writes prevent a TORN file. They do nothing about a LOST update, and
// read-modify-write is exactly the shape that loses one. That distinction is
// the reason this exists.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** How long a lock may be held before it is treated as abandoned. */
export const LOCK_STALE_MS = 10_000;

/**
 * Total time to wait for a contended lock before giving up.
 *
 * Deliberately LONGER than {@link LOCK_STALE_MS}: with the shorter value a
 * caller gave up before a genuinely crashed holder's lock became breakable, so
 * every write failed for a window instead of waiting it out.
 */
export const LOCK_TIMEOUT_MS = 15_000;

function sleepSync(ms: number): void {
  const bunSleep = (globalThis as { Bun?: { sleepSync?: (ms: number) => void } }).Bun?.sleepSync;
  if (typeof bunSleep === "function") {
    bunSleep(ms);
    return;
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait fallback; the critical section is a few file operations long.
  }
}

/**
 * Run `fn` while holding an exclusive lock at `lockPath`.
 *
 * A lock older than {@link LOCK_STALE_MS} is treated as abandoned — a process
 * killed mid-write must not wedge every future write.
 *
 * Returns `null` when the lock could not be taken, which callers surface as a
 * write failure rather than a throw. `waitingMessage` is emitted once through
 * `onWaiting` when the wait becomes long enough to look like a hang.
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  options: { onWaiting?: ((message: string) => void) | undefined; waitingMessage?: string } = {},
): T | null {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  // A nonce identifies THIS holder. Without it, a holder whose critical section
  // ran past the stale threshold has its lock broken by someone else and then
  // deletes the new holder's lock in its own `finally` — letting a third caller
  // in while the second is still inside, which is the lost update the lock
  // exists to prevent.
  const nonce = randomUUID();
  const started = Date.now();
  const deadline = started + LOCK_TIMEOUT_MS;
  let handle: number | null = null;
  let announced = false;

  while (handle === null) {
    // The deadline is checked FIRST, before the stale branch. Checking it only
    // in the contended branch meant an unremovable stale lock (read-only or
    // root-owned config dir) spun forever at full CPU instead of degrading to a
    // reported write failure.
    if (Date.now() > deadline) {
      return null;
    }
    try {
      handle = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(handle, nonce, { encoding: "utf8" });
      } catch (cause) {
        // The open succeeded but the nonce did not land. Leaving `handle` set
        // would run the critical section holding a lock whose contents can never
        // match, so the finally would decline to remove it and every other
        // caller would wait out the stale window. Drop it and retry cleanly.
        closeSync(handle);
        handle = null;
        rmSync(lockPath, { force: true });
        throw cause;
      }
    } catch {
      const age = statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs;
      if (age !== undefined && Date.now() - age > LOCK_STALE_MS) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Someone else broke it first, or we cannot remove it at all; either
          // way sleep and retry until the deadline rather than spinning.
        }
      }
      // A crashed holder costs the next caller the full stale window, and an
      // unwritable config dir costs the whole timeout. Silence for that long
      // reads as a hang, so say what is happening once.
      if (!announced && Date.now() - started > 1_000) {
        announced = true;
        options.onWaiting?.(options.waitingMessage ?? "waiting for a keryx config lock…");
      }
      sleepSync(15);
    }
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(handle);
    } catch {
      // already closed
    }
    // Only remove the lock if it is still OURS. If it was broken as stale and
    // retaken, the file now holds someone else's nonce and must be left alone.
    try {
      if (readFileSync(lockPath, "utf8") === nonce) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Gone already, or unreadable; a leftover goes stale and is broken above.
    }
  }
}

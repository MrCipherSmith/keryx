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

export interface FileLockOptions {
  onWaiting?: ((message: string) => void) | undefined;
  waitingMessage?: string;
  /** Override {@link LOCK_TIMEOUT_MS} — a caller on an interactive path must not wait 15s. */
  timeoutMs?: number;
  /** Override {@link LOCK_STALE_MS} — a short critical section can call its lock abandoned sooner. */
  staleMs?: number;
  /**
   * `false`: the lock's directory must already exist and is never created. A
   * missing directory throws its ENOENT at once instead of being waited out —
   * for a lock inside a directory another process may delete (a session moved
   * to the trash), which taking the lock must not bring back. Default `true`.
   */
  createDir?: boolean;
}

/**
 * One attempt to take the lock at a time, shared by the synchronous and the
 * asynchronous waits so both keep the same rules: exclusive create, a nonce,
 * the deadline checked before the stale branch, and stale takeover.
 */
class LockAttempt {
  // A nonce identifies THIS holder. Without it, a holder whose critical section
  // ran past the stale threshold has its lock broken by someone else and then
  // deletes the new holder's lock in its own `finally` — letting a third caller
  // in while the second is still inside, which is the lost update the lock
  // exists to prevent.
  private readonly nonce = randomUUID();
  private readonly started = Date.now();
  private readonly deadline: number;
  private readonly staleMs: number;
  private announced = false;

  constructor(private readonly lockPath: string, private readonly options: FileLockOptions) {
    this.deadline = this.started + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
    this.staleMs = options.staleMs ?? LOCK_STALE_MS;
  }

  /**
   * Creates the lock's directory unless `createDir` is false; false when it
   * cannot be made. With `createDir: false` it does not look: a missing
   * directory surfaces as ENOENT from the first {@link step}.
   */
  prepare(): boolean {
    if (this.options.createDir === false) return true;
    try {
      mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }

  /** The held lock's handle, `null` to pause and retry, or `"timeout"`. */
  step(): number | null | "timeout" {
    // The deadline is checked FIRST, before the stale branch. Checking it only
    // in the contended branch meant an unremovable stale lock (read-only or
    // root-owned config dir) spun forever at full CPU instead of degrading to a
    // reported write failure.
    if (Date.now() > this.deadline) return "timeout";
    let handle: number | null = null;
    try {
      handle = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(handle, this.nonce, { encoding: "utf8" });
      return handle;
    } catch (error) {
      if (handle !== null) {
        // The open succeeded but the nonce did not land. Holding it would run the
        // critical section holding a lock whose contents can never match, so the
        // release would decline to remove it and every other caller would wait
        // out the stale window. Drop it and retry cleanly.
        closeSync(handle);
        rmSync(this.lockPath, { force: true });
      }
      if (this.options.createDir === false && (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    }
    const age = statSync(this.lockPath, { throwIfNoEntry: false })?.mtimeMs;
    if (age !== undefined && Date.now() - age > this.staleMs) {
      try {
        rmSync(this.lockPath, { force: true });
      } catch {
        // Someone else broke it first, or we cannot remove it at all; either
        // way pause and retry until the deadline rather than spinning.
      }
    }
    // A crashed holder costs the next caller the full stale window, and an
    // unwritable config dir costs the whole timeout. Silence for that long
    // reads as a hang, so say what is happening once.
    if (!this.announced && Date.now() - this.started > 1_000) {
      this.announced = true;
      this.options.onWaiting?.(this.options.waitingMessage ?? "waiting for a keryx config lock…");
    }
    return null;
  }

  release(handle: number): void {
    try {
      closeSync(handle);
    } catch {
      // already closed
    }
    // Only remove the lock if it is still OURS. If it was broken as stale and
    // retaken, the file now holds someone else's nonce and must be left alone.
    try {
      if (readFileSync(this.lockPath, "utf8") === this.nonce) {
        rmSync(this.lockPath, { force: true });
      }
    } catch {
      // Gone already, or unreadable; a leftover goes stale and is broken above.
    }
  }
}

/** Pause between attempts on a contended lock. */
export const LOCK_RETRY_MS = 15;

/**
 * Run `fn` while holding an exclusive lock at `lockPath`.
 *
 * A lock older than {@link LOCK_STALE_MS} is treated as abandoned — a process
 * killed mid-write must not wedge every future write.
 *
 * Returns `null` when the lock could not be taken in time (or, by default, its
 * directory could not be created), which callers surface as a write failure
 * rather than a throw. With `createDir: false` a missing directory is not
 * waited out: its ENOENT is thrown at once. `waitingMessage` is emitted once
 * through `onWaiting` when the wait becomes long enough to look like a hang.
 *
 * The wait blocks the thread; a long-lived server with other work on its event
 * loop uses {@link withFileLockAsync}, which takes the same lock.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T | null {
  const attempt = new LockAttempt(lockPath, options);
  if (!attempt.prepare()) return null;
  let handle = attempt.step();
  while (handle === null) {
    sleepSync(LOCK_RETRY_MS);
    handle = attempt.step();
  }
  if (handle === "timeout") return null;
  try {
    return fn();
  } finally {
    attempt.release(handle);
  }
}

/**
 * {@link withFileLock} with a wait that yields to the event loop between
 * attempts. The lock file, nonce, stale rule and timeout are the same, so a
 * synchronous holder in another process excludes this one and the reverse.
 * Resolves `null` when the lock could not be taken, and rejects with ENOENT
 * for a missing directory under `createDir: false`, as withFileLock throws it.
 */
export async function withFileLockAsync<T>(lockPath: string, fn: () => T | Promise<T>, options: FileLockOptions = {}): Promise<T | null> {
  const attempt = new LockAttempt(lockPath, options);
  if (!attempt.prepare()) return null;
  let handle = attempt.step();
  while (handle === null) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    handle = attempt.step();
  }
  if (handle === "timeout") return null;
  try {
    return await fn();
  } finally {
    attempt.release(handle);
  }
}

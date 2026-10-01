// The single-poller lock (flow 376, block 2).
//
// Telegram lets exactly one `getUpdates` consumer own a bot token; a second one
// makes the FIRST receive 409. The hub treats a 409 as terminal, so a second
// `keryx serve` on this machine must never even probe. It also must not share the
// hub's on-disk state (outbound flush, session sweep) with a running one.
//
// So the poller is guarded by `<remote dir>/poller.lock`, holding the owner's pid.
// A lock whose pid is no longer a live process is taken over (a crashed serve must
// not wedge remote control forever). A lock held by a live pid refuses: the caller
// never starts a hub and says why.
//
// Two properties make the lock safe against another serve starting at the same
// moment:
//
//   - It is created whole. The pid is written to a private temp file and `link()`ed
//     to the lock name, which is atomic and exclusive, so nobody can ever read a
//     lock that exists but is still empty.
//   - A stale lock is taken over by RENAMING it aside and looking at what was
//     moved, never by unlink-then-create. If what was moved turns out to be a fresh
//     lock another serve just took, it is put back and this caller refuses.
//
// A lock file that holds no pid is held, not free, while it is young: it may be a
// serve of an older build in the middle of writing it. Only one older than
// {@link EMPTY_LOCK_GRACE_MS} is taken over.
//
// This covers two serves on one machine. A serve on ANOTHER machine with the same
// token is only detectable by the 409, which the hub already reports as a
// `conflict` poller status; the service stops the hub on it.

import { randomBytes } from "node:crypto";
import { linkSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createOwnerOnlyFileExclusive, readConfigFile } from "../lib/config-dir";
import { ensureRemoteDir, remoteDirPath } from "./paths";

export const POLLER_LOCK_FILE = "poller.lock";
/** A lock file with no readable pid younger than this is somebody mid-write, not a corpse. */
export const EMPTY_LOCK_GRACE_MS = 5_000;

export function pollerLockPath(dir?: string): string {
  return path.join(remoteDirPath(dir), POLLER_LOCK_FILE);
}

export type PollLock = { ok: true; release(): void } | { ok: false; holderPid: number; reason: string };

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and is somebody else's.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export interface AcquirePollLockOptions {
  dir?: string | undefined;
  pid?: number;
  /** Test seam. */
  isAlive?: (pid: number) => boolean;
  /** Test seam: the clock the empty-lock grace period is measured on. */
  now?: () => number;
}

function parsePid(text: string): number {
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : Number.NaN;
}

function refusal(holder: number): PollLock {
  return {
    ok: false,
    holderPid: holder,
    reason: `another keryx serve (pid ${holder}) already polls this bot token on this machine; this one will not poll. Stop it, or use a different bot.`,
  };
}

/** Create `file` holding `pid`, whole or not at all. False when it already exists. */
function createWhole(file: string, pid: number): boolean {
  const staging = `${file}.${pid}.${randomBytes(6).toString("hex")}.new`;
  createOwnerOnlyFileExclusive(staging, `${pid}\n`);
  try {
    linkSync(staging, file);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return false;
    }
    // A filesystem without hard links: fall back to plain exclusive creation.
    return createOwnerOnlyFileExclusive(file, `${pid}\n`);
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      // Already gone.
    }
  }
}

export function acquirePollLock(options: AcquirePollLockOptions = {}): PollLock {
  ensureRemoteDir(options.dir);
  const file = pollerLockPath(options.dir);
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? Date.now;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (createWhole(file, pid)) {
      return {
        ok: true,
        release() {
          // Only the owner removes it: after a takeover the file is somebody else's.
          const current = readConfigFile(file);
          if (current.ok && parsePid(current.text) === pid) {
            try {
              unlinkSync(file);
            } catch {
              // Already gone.
            }
          }
        },
      };
    }
    const held = readConfigFile(file);
    if (!held.ok && held.reason === "absent") {
      // Released between our create and our read: just try again.
      continue;
    }
    const holder = held.ok ? parsePid(held.text) : Number.NaN;
    if (Number.isInteger(holder) && isAlive(holder)) {
      return refusal(holder);
    }
    if (!Number.isInteger(holder)) {
      // No pid in it: somebody may be writing it right now. Only an old one is a corpse.
      let youngerThanGrace: boolean;
      try {
        youngerThanGrace = now() - statSync(file).mtimeMs < EMPTY_LOCK_GRACE_MS;
      } catch {
        continue;
      }
      if (youngerThanGrace) {
        return {
          ok: false,
          holderPid: 0,
          reason: `another keryx serve is creating ${file} right now; this one will not poll. Try again in a moment.`,
        };
      }
    }
    // A dead holder, or a pid-less lock that has been sitting there: move it aside
    // and look at what we actually moved. Another taker may have replaced it since
    // we read it, and that one is not ours to remove.
    const aside = `${file}.stale-${pid}-${randomBytes(6).toString("hex")}`;
    try {
      renameSync(file, aside);
    } catch {
      continue;
    }
    const moved = readConfigFile(aside);
    const movedPid = moved.ok ? parsePid(moved.text) : Number.NaN;
    if (Number.isInteger(movedPid) && movedPid !== holder && isAlive(movedPid)) {
      // We took somebody's fresh lock. Put it back if the name is still free; either way we do not poll.
      try {
        linkSync(aside, file);
      } catch {
        // Somebody else created one meanwhile; theirs stands.
      }
      try {
        unlinkSync(aside);
      } catch {
        // Already gone.
      }
      return refusal(movedPid);
    }
    try {
      unlinkSync(aside);
    } catch {
      // Already gone.
    }
  }
  return { ok: false, holderPid: 0, reason: `could not take the poller lock at ${file}` };
}

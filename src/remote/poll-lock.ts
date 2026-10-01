// The single-poller lock (flow 376, block 2).
//
// Telegram lets exactly one `getUpdates` consumer own a bot token; a second one
// makes the FIRST receive 409. The hub treats a 409 as terminal, so a second
// `keryx serve` on this machine must never even probe. It also must not share the
// hub's on-disk state (outbound flush, session sweep) with a running one.
//
// So the poller is guarded by `<remote dir>/poller.lock`, holding the owner's pid,
// created with `O_EXCL`. A lock whose pid is no longer a live process is taken
// over (a crashed serve must not wedge remote control forever). A lock held by a
// live pid refuses: the caller never starts a hub and says why.
//
// This covers two serves on one machine. A serve on ANOTHER machine with the same
// token is only detectable by the 409, which the hub already reports as a
// `conflict` poller status; the service stops the hub on it.

import { unlinkSync } from "node:fs";
import path from "node:path";
import { createOwnerOnlyFileExclusive, readConfigFile } from "../lib/config-dir";
import { ensureRemoteDir, remoteDirPath } from "./paths";

export const POLLER_LOCK_FILE = "poller.lock";

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
}

export function acquirePollLock(options: AcquirePollLockOptions = {}): PollLock {
  ensureRemoteDir(options.dir);
  const file = pollerLockPath(options.dir);
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createOwnerOnlyFileExclusive(file, `${pid}\n`)) {
      return {
        ok: true,
        release() {
          // Only the owner removes it: after a takeover the file is somebody else's.
          const current = readConfigFile(file);
          if (current.ok && Number.parseInt(current.text.trim(), 10) === pid) {
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
    const holder = held.ok ? Number.parseInt(held.text.trim(), 10) : Number.NaN;
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
      return {
        ok: false,
        holderPid: holder,
        reason: `another keryx serve (pid ${holder}) already polls this bot token on this machine; this one will not poll. Stop it, or use a different bot.`,
      };
    }
    // Dead holder, or a file that holds no pid: take it over.
    try {
      unlinkSync(file);
    } catch {
      // Raced with another taker; the next attempt decides.
    }
  }
  return { ok: false, holderPid: 0, reason: `could not take the poller lock at ${file}` };
}

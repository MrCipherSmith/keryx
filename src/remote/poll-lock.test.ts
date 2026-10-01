// The single-poller lock: one `keryx serve` polls a bot token per machine.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquirePollLock, EMPTY_LOCK_GRACE_MS, pollerLockPath } from "./poll-lock";
import { ensureRemoteDir } from "./paths";
import { fileMode, makeRemoteDir } from "./remote.test-helpers";

const dirs: string[] = [];
function freshDir(): string {
  const dir = makeRemoteDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("acquirePollLock", () => {
  test("the first caller gets it, owner-only, holding its pid", () => {
    const dir = freshDir();
    const lock = acquirePollLock({ dir, pid: 41_001 });
    expect(lock.ok).toBe(true);
    expect(fileMode(pollerLockPath(dir))).toBe(0o600);
  });

  test("a live holder refuses a second caller and is named in the reason", () => {
    const dir = freshDir();
    acquirePollLock({ dir, pid: 41_002, isAlive: () => true });
    const second = acquirePollLock({ dir, pid: 41_003, isAlive: () => true });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holderPid).toBe(41_002);
      expect(second.reason).toContain("41002");
      expect(second.reason).toContain("will not poll");
    }
  });

  test("a holder that is gone is taken over", () => {
    const dir = freshDir();
    acquirePollLock({ dir, pid: 41_004 });
    const takeover = acquirePollLock({ dir, pid: 41_005, isAlive: () => false });
    expect(takeover.ok).toBe(true);
  });

  test("a lock file with no pid in it is taken over once it is old", () => {
    const dir = freshDir();
    acquirePollLock({ dir, pid: 41_006 });
    writeFileSync(pollerLockPath(dir), "garbage\n", { mode: 0o600 });
    const old = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 1_000);
    utimesSync(pollerLockPath(dir), old, old);
    expect(acquirePollLock({ dir, pid: 41_007, isAlive: () => true }).ok).toBe(true);
    expect(readFileSync(pollerLockPath(dir), "utf8").trim()).toBe("41007");
  });

  test("a young lock with no pid in it is somebody mid-write: held, not taken over", () => {
    const dir = freshDir();
    ensureRemoteDir(dir);
    writeFileSync(pollerLockPath(dir), "", { mode: 0o600 });
    const second = acquirePollLock({ dir, pid: 41_011, isAlive: () => false });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain("creating");
    }
    // The file is untouched.
    expect(readFileSync(pollerLockPath(dir), "utf8")).toBe("");
  });

  test("the lock is never visible half-written: it holds a whole pid the moment it exists", () => {
    const dir = freshDir();
    const lock = acquirePollLock({ dir, pid: 41_012 });
    expect(lock.ok).toBe(true);
    expect(readFileSync(pollerLockPath(dir), "utf8")).toBe("41012\n");
    // No staging file is left behind.
    const left = readdirSync(path.dirname(pollerLockPath(dir))).filter((name) => name.includes(".new") || name.includes(".stale"));
    expect(left).toEqual([]);
  });

  test("two takers of the same dead lock: the one that loses the race puts the winner's lock back and refuses", () => {
    const dir = freshDir();
    ensureRemoteDir(dir);
    writeFileSync(pollerLockPath(dir), "41100\n", { mode: 0o600 });
    let winner: ReturnType<typeof acquirePollLock> | undefined;
    let raced = false;
    // B has read the dead holder and is deciding it is dead; inside that decision A takes the lock over.
    const second = acquirePollLock({
      dir,
      pid: 41_102,
      isAlive: (pid) => {
        if (pid === 41_100) {
          if (!raced) {
            raced = true;
            winner = acquirePollLock({ dir, pid: 41_101, isAlive: (other) => other !== 41_100 });
          }
          return false;
        }
        return true;
      },
    });
    expect(winner?.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holderPid).toBe(41_101);
    }
    // The winner's lock is still the lock.
    expect(readFileSync(pollerLockPath(dir), "utf8").trim()).toBe("41101");
  });

  test("release removes the file, and only for the owner", () => {
    const dir = freshDir();
    const first = acquirePollLock({ dir, pid: 41_008 });
    if (!first.ok) {
      throw new Error("the first caller should hold the lock");
    }
    // Someone took it over after we were considered dead.
    const taker = acquirePollLock({ dir, pid: 41_009, isAlive: () => false });
    first.release();
    expect(existsSync(pollerLockPath(dir))).toBe(true);
    if (!taker.ok) {
      throw new Error("the second caller should hold the lock");
    }
    taker.release();
    expect(existsSync(pollerLockPath(dir))).toBe(false);
    // And it can be taken again.
    expect(acquirePollLock({ dir, pid: 41_010 }).ok).toBe(true);
  });

  test("this process counts as a live holder", () => {
    const dir = freshDir();
    expect(acquirePollLock({ dir }).ok).toBe(true);
    expect(acquirePollLock({ dir }).ok).toBe(false);
  });
});

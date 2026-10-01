// The single-poller lock: one `keryx serve` polls a bot token per machine.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { acquirePollLock, pollerLockPath } from "./poll-lock";
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

  test("a lock file with no pid in it is taken over", () => {
    const dir = freshDir();
    acquirePollLock({ dir, pid: 41_006 });
    writeFileSync(pollerLockPath(dir), "garbage\n", { mode: 0o600 });
    expect(acquirePollLock({ dir, pid: 41_007, isAlive: () => true }).ok).toBe(true);
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

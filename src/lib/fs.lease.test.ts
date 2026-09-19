// Long-held lease primitive (agent bus P0, spec §3.1, D-09).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import {
  acquireLeaseSync,
  inspectLeaseSync,
  type LeaseOwnerBase,
  readLeaseOwnerSync,
  reclaimStaleLeaseSync,
} from "./fs";

interface TestOwner extends LeaseOwnerBase {
  name: string | null;
}

const STALE_MS = 15_000;
let root: string;
let lockPath: string;

function owner(overrides: Partial<TestOwner> = {}): TestOwner {
  return {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    heartbeatAt: new Date().toISOString(),
    name: null,
    ...overrides,
  };
}

/** Plant a holder directly on disk, as another process would have left it. */
function plant(holder: TestOwner): void {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(holder), { mode: 0o600 });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-lease-"));
  lockPath = path.join(root, "session", "active.lease");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acquireLeaseSync", () => {
  test("acquires, and a second acquire is refused as live", () => {
    const first = acquireLeaseSync(lockPath, owner(), { staleMs: STALE_MS });
    expect(first.ok).toBe(true);
    const mine = first.ok ? first.handle.owner : undefined;

    const second = acquireLeaseSync(lockPath, owner(), { staleMs: STALE_MS });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.state).toBe("live");
      expect(second.holder?.token).toBe(mine?.token);
    }
  });

  test("creates the directory 0700 and owner.json 0600", () => {
    const got = acquireLeaseSync(lockPath, owner(), { staleMs: STALE_MS });
    expect(got.ok).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(lockPath, "owner.json")).mode & 0o777).toBe(0o600);
  });

  test("an old heartbeat on this host with a live pid is stale and is not reclaimed", () => {
    const holder = owner({ pid: 424242, heartbeatAt: new Date(1_000).toISOString() });
    plant(holder);
    const got = acquireLeaseSync(lockPath, owner(), {
      staleMs: STALE_MS,
      now: () => 1_000 + STALE_MS + 1,
      isAlive: () => true,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.state).toBe("stale");
      expect(got.holder?.token).toBe(holder.token);
    }
    expect(readLeaseOwnerSync(lockPath)?.token).toBe(holder.token);
  });

  test("an old heartbeat with a dead pid is gone and is reclaimed silently", () => {
    plant(owner({ pid: 424242, heartbeatAt: new Date(1_000).toISOString() }));
    const next = owner();
    const got = acquireLeaseSync(lockPath, next, {
      staleMs: STALE_MS,
      now: () => 1_000 + STALE_MS + 1,
      isAlive: () => false,
    });
    expect(got.ok).toBe(true);
    expect(readLeaseOwnerSync(lockPath)?.token).toBe(next.token);
  });

  test("an old heartbeat from another host is gone even when the pid is alive here", () => {
    plant(owner({ host: "some-other-host", heartbeatAt: new Date(1_000).toISOString() }));
    const next = owner();
    const got = acquireLeaseSync(lockPath, next, {
      staleMs: STALE_MS,
      now: () => 1_000 + STALE_MS + 1,
      isAlive: () => true,
    });
    expect(got.ok).toBe(true);
    expect(readLeaseOwnerSync(lockPath)?.token).toBe(next.token);
  });

  test("a fresh heartbeat is live whatever the pid says", () => {
    plant(owner({ pid: 424242, host: "elsewhere" }));
    const got = acquireLeaseSync(lockPath, owner(), { staleMs: STALE_MS, isAlive: () => false });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.state).toBe("live");
  });

  test("a missing owner.json in a fresh directory is live; in an old one it is gone", () => {
    mkdirSync(lockPath, { recursive: true });
    const fresh = acquireLeaseSync(lockPath, owner(), { staleMs: STALE_MS });
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) {
      expect(fresh.state).toBe("live");
      expect(fresh.holder).toBeUndefined();
    }

    writeFileSync(path.join(lockPath, "owner.json"), "{not json");
    const old = new Date(Date.now() - STALE_MS * 2);
    utimesSync(lockPath, old, old);
    const next = owner();
    const reclaimed = acquireLeaseSync(lockPath, next, { staleMs: STALE_MS });
    expect(reclaimed.ok).toBe(true);
    expect(readLeaseOwnerSync(lockPath)?.token).toBe(next.token);
  });

  test("reclaimIf lets a caller reclaim its own leftover lease", () => {
    const leftover = owner();
    plant(leftover);
    const got = acquireLeaseSync(lockPath, owner(), {
      staleMs: STALE_MS,
      reclaimIf: (holder) => holder.token === leftover.token,
    });
    expect(got.ok).toBe(true);
  });
});

describe("LeaseHandle", () => {
  test("refresh rewrites heartbeatAt and merges a patch, keeping the token", () => {
    let clock = 10_000;
    const initial = owner({ heartbeatAt: new Date(clock).toISOString() });
    const got = acquireLeaseSync(lockPath, initial, { staleMs: STALE_MS, now: () => clock });
    if (!got.ok) throw new Error("expected to acquire");
    clock = 20_000;
    expect(got.handle.refresh({ name: "alpha", token: "forged" })).toBe(true);
    const onDisk = readLeaseOwnerSync<TestOwner>(lockPath);
    expect(onDisk?.heartbeatAt).toBe(new Date(20_000).toISOString());
    expect(onDisk?.name).toBe("alpha");
    expect(onDisk?.token).toBe(initial.token);
    expect(got.handle.owner.name).toBe("alpha");
    expect(statSync(path.join(lockPath, "owner.json")).mode & 0o777).toBe(0o600);
    // No temp file is left behind in the lease directory.
    expect(readdirSync(lockPath)).toEqual(["owner.json"]);
  });

  test("release removes the lease and is idempotent", () => {
    const got = acquireLeaseSync(lockPath, owner(), { staleMs: STALE_MS });
    if (!got.ok) throw new Error("expected to acquire");
    got.handle.release();
    got.handle.release();
    expect(() => statSync(lockPath)).toThrow();
    expect(got.handle.refresh()).toBe(false);
  });

  test("release with a token that no longer matches is a no-op", () => {
    const got = acquireLeaseSync(lockPath, owner(), { staleMs: STALE_MS });
    if (!got.ok) throw new Error("expected to acquire");
    // Someone else now holds the path.
    const other = owner();
    writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(other), { mode: 0o600 });
    expect(got.handle.refresh()).toBe(false);
    got.handle.release();
    expect(readLeaseOwnerSync(lockPath)?.token).toBe(other.token);
  });
});

describe("reclaimStaleLeaseSync", () => {
  test("refuses a live holder and leaves it in place", () => {
    const holder = owner({ pid: 424242 });
    plant(holder);
    const got = reclaimStaleLeaseSync(lockPath, owner(), { staleMs: STALE_MS, isAlive: () => true });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.state).toBe("live");
    expect(readLeaseOwnerSync(lockPath)?.token).toBe(holder.token);
  });

  test("takes over a stale holder", () => {
    plant(owner({ pid: 424242, heartbeatAt: new Date(1_000).toISOString() }));
    const next = owner();
    const got = reclaimStaleLeaseSync(lockPath, next, {
      staleMs: STALE_MS,
      now: () => 1_000 + STALE_MS + 1,
      isAlive: () => true,
    });
    expect(got.ok).toBe(true);
    expect(readLeaseOwnerSync(lockPath)?.token).toBe(next.token);
  });

  test("acquires a free lease", () => {
    expect(reclaimStaleLeaseSync(lockPath, owner(), { staleMs: STALE_MS }).ok).toBe(true);
  });
});

describe("inspectLeaseSync", () => {
  test("reports free when there is no lease directory", () => {
    expect(inspectLeaseSync(lockPath, { staleMs: STALE_MS }).state).toBe("free");
  });
});

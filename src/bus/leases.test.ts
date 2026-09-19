import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { holderLivenessFrom, isLeaseActive, listActiveLeases, listLeases, readLease } from "./leases";
import { leasePath, leasesDir } from "./paths";
import type { PauseLease, PresenceRecord } from "./schema";

// §4.3 active rule, read side (P1).

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function busRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-leases-"));
  ROOTS.push(dir);
  return dir;
}

const HOLDER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const L1 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const L2 = "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f";
const L3 = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const T0 = Date.parse("2026-09-19T10:00:00.000Z");

function lease(overrides: Partial<PauseLease> = {}): PauseLease {
  return {
    schemaVersion: 1,
    leaseId: L1,
    holder: { instanceId: HOLDER, name: "release", origin: "agent" },
    targets: ["*"],
    scope: "turns",
    reason: "releasing",
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 30 * 60_000).toISOString(),
    requestEventSeq: 1,
    ...overrides,
  };
}

function presence(heartbeatAt: number, overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId: HOLDER,
    name: "release",
    pid: 4242,
    host: "this-host",
    sessionId: L3,
    checkout: "/repo",
    branch: null,
    surface: "tui",
    status: "idle",
    activity: "",
    startedAt: new Date(T0).toISOString(),
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    keryxVersion: "0.2.121",
    ...overrides,
  };
}

const classify = { host: "this-host", isAlive: (pid: number) => pid === 4242 };

describe("isLeaseActive", () => {
  const at = (now: number, holder: PresenceRecord[]) => ({ now, holderLiveness: holderLivenessFrom(holder, { ...classify, now }) });

  test("active before expiresAt with a live holder; inactive at expiresAt", () => {
    expect(isLeaseActive(lease(), at(T0 + 1_000, [presence(T0)]))).toBe(true);
    expect(isLeaseActive(lease(), at(T0 + 30 * 60_000, [presence(T0 + 30 * 60_000)]))).toBe(false);
  });

  test("a stale holder keeps its lease; a gone or absent holder loses it", () => {
    expect(isLeaseActive(lease(), at(T0 + 60_000, [presence(T0)]))).toBe(true); // stale: same host, pid alive
    expect(isLeaseActive(lease(), at(T0 + 60_000, [presence(T0, { pid: 7 })]))).toBe(false); // gone
    expect(isLeaseActive(lease(), at(T0 + 1_000, []))).toBe(false); // no presence
  });

  test("a CLI holder has no presence and is bounded by the TTL alone", () => {
    const cli = lease({ holder: { instanceId: HOLDER, name: "cli", origin: "cli" } });
    expect(isLeaseActive(cli, at(T0 + 1_000, []))).toBe(true);
    expect(isLeaseActive(cli, at(T0 + 30 * 60_000, []))).toBe(false);
  });
});

describe("listLeases / listActiveLeases", () => {
  test("lists valid files, skips invalid ones, and filters by the active rule", async () => {
    const root = await busRoot();
    await mkdir(leasesDir(root), { recursive: true });
    await writeFile(leasePath(root, L1), JSON.stringify(lease()), "utf8");
    await writeFile(
      leasePath(root, L2),
      JSON.stringify(lease({ leaseId: L2, expiresAt: new Date(T0 + 60_000).toISOString(), createdAt: new Date(T0 + 1).toISOString() })),
      "utf8",
    );
    await writeFile(leasePath(root, L3), JSON.stringify(lease({ leaseId: L1 })), "utf8"); // id mismatch
    await writeFile(path.join(leasesDir(root), "junk.json"), "{", "utf8");

    expect((await listLeases(root)).map((l) => l.leaseId)).toEqual([L1, L2]);
    const now = T0 + 2 * 60_000;
    const active = await listActiveLeases(root, { now, holderLiveness: holderLivenessFrom([presence(now)], { ...classify, now }) });
    expect(active.map((l) => l.leaseId)).toEqual([L1]);
    expect(await readLease(root, "../x")).toBeUndefined();
    expect(await listLeases(path.join(root, "missing"))).toEqual([]);
  });
});

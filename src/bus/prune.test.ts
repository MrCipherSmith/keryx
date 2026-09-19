import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cursorAtStart, readEvents } from "./log";
import { leasePath, leasesDir, rotatedSegmentPath } from "./paths";
import { listPresence, writePresence } from "./presence";
import { pruneBus } from "./prune";
import type { PauseLease, PresenceRecord } from "./schema";

// AC11: prune removes gone-for-24h presence, inactive leases and excess
// rotated segments, and leaves live and stale records alone.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function busRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-prune-"));
  ROOTS.push(dir);
  return path.join(dir, "bus");
}

const ID = {
  live: "0f8fad5b-d9cb-469f-a165-70867728950e",
  stale: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  goneRecent: "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",
  goneOld: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  session: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
};
const LEASE = {
  active: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b",
  expired: "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c",
  goneHolder: "5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d",
};
const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const HOUR = 60 * 60_000;

function presence(instanceId: string, name: string, heartbeatAt: number, pid: number): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId,
    name,
    pid,
    host: "this-host",
    sessionId: ID.session,
    checkout: "/repo",
    branch: null,
    surface: "readline",
    status: "idle",
    activity: "",
    startedAt: new Date(heartbeatAt).toISOString(),
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    keryxVersion: "0.2.121",
  };
}

function lease(leaseId: string, holder: string, expiresAt: number): PauseLease {
  return {
    schemaVersion: 1,
    leaseId,
    holder: { instanceId: holder, name: "holder", origin: "agent" },
    targets: ["*"],
    scope: "turns",
    reason: "release",
    createdAt: new Date(expiresAt - HOUR).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    requestEventSeq: 1,
  };
}

const options = { now: () => NOW, host: "this-host", isAlive: (pid: number) => pid === 100 || pid === 200 };

describe("pruneBus", () => {
  test("removes what is gone, inactive or beyond retention, and nothing else", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.live, "live", NOW - 1_000, 100));
    await writePresence(root, presence(ID.stale, "stale", NOW - 30 * HOUR, 200)); // stale for 30 h: kept
    await writePresence(root, presence(ID.goneRecent, "gone-recent", NOW - 2 * HOUR, 300)); // gone < 24 h: kept
    await writePresence(root, presence(ID.goneOld, "gone-old", NOW - 25 * HOUR, 400)); // gone > 24 h: removed

    await mkdir(leasesDir(root), { recursive: true });
    await writeFile(leasePath(root, LEASE.active), JSON.stringify(lease(LEASE.active, ID.live, NOW + HOUR)), "utf8");
    await writeFile(leasePath(root, LEASE.expired), JSON.stringify(lease(LEASE.expired, ID.live, NOW - 1)), "utf8");
    await writeFile(leasePath(root, LEASE.goneHolder), JSON.stringify(lease(LEASE.goneHolder, ID.goneRecent, NOW + HOUR)), "utf8");

    for (const segment of [1, 2, 3, 4]) await writeFile(rotatedSegmentPath(root, segment), "", "utf8");

    const result = await pruneBus(root, options);

    expect(result.presence).toEqual([ID.goneOld]);
    expect(result.leases.sort()).toEqual([LEASE.expired, LEASE.goneHolder].sort());
    expect(result.segments.sort()).toEqual([rotatedSegmentPath(root, 1), rotatedSegmentPath(root, 2)].sort());

    expect((await listPresence(root)).map((r) => r.name)).toEqual(["gone-recent", "live", "stale"]);
    expect(await readdir(leasesDir(root))).toEqual([`${LEASE.active}.json`]);
    // One lease-expired event per removed lease, from the system origin.
    const events = (await readEvents(root, await cursorAtStart(root))).events;
    expect(events.map((e) => [e.kind, e.from.origin, e.refs?.leaseId])).toEqual(
      expect.arrayContaining([
        ["lease-expired", "system", LEASE.expired],
        ["lease-expired", "system", LEASE.goneHolder],
      ]),
    );
    expect(events.length).toBe(2);
  });

  test("a second prune finds nothing more and writes no second lease-expired", async () => {
    const root = await busRoot();
    await mkdir(leasesDir(root), { recursive: true });
    await writeFile(leasePath(root, LEASE.expired), JSON.stringify(lease(LEASE.expired, ID.live, NOW - 1)), "utf8");

    const [first, second] = await Promise.all([pruneBus(root, options), pruneBus(root, options)]);
    const third = await pruneBus(root, options);

    expect([...first.leases, ...second.leases]).toEqual([LEASE.expired]);
    expect(third).toEqual({ presence: [], leases: [], segments: [] });
    expect((await readEvents(root, await cursorAtStart(root))).events.length).toBe(1);
  });

  test("a missing bus root prunes nothing and creates nothing", async () => {
    const root = await busRoot();
    expect(await pruneBus(root, options)).toEqual({ presence: [], leases: [], segments: [] });
    expect(await readdir(path.dirname(root))).toEqual([]);
  });
});

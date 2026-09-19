import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBusRefusal, type BusRefusalCode } from "./errors";
import { readLease } from "./leases";
import { cursorAtStart, readEvents } from "./log";
import {
  createLeaseView,
  createPauseLease,
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  overridePauseLease,
  resumePauseLease,
  type PauseLeaseActor,
} from "./pause";
import { writePresence } from "./presence";
import { pruneBus } from "./prune";
import type { PresenceRecord } from "./schema";

// flow 275 T5, AC1-AC3, AC6, AC9 (pause-lease slice): create/resume/override,
// every named refusal, D-03's "never targets the holder", the CLI clone-wide
// limit, and the exactly-once lease-expired boundary this module hands off to
// `./prune.ts` unchanged.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function busRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-pause-"));
  ROOTS.push(dir);
  return path.join(dir, "bus");
}

const ID = {
  holder: "0f8fad5b-d9cb-469f-a165-70867728950e",
  target: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  other: "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",
  cli1: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  cli2: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  session: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b",
};
const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const MIN = 60_000;

const HOLDER: PauseLeaseActor = { instanceId: ID.holder, name: "release", origin: "agent" };

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
    surface: "tui",
    status: "idle",
    activity: "",
    startedAt: new Date(heartbeatAt).toISOString(),
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    keryxVersion: "0.2.121",
  };
}

const clock = { now: () => NOW };
const liveness = { host: "this-host", isAlive: (pid: number) => pid === 100 };

async function allEvents(root: string) {
  return (await readEvents(root, await cursorAtStart(root))).events;
}

/** Same pattern as `./send.test.ts`'s `refusal`: the refusal code of a rejected promise, or undefined. */
async function refusal(promise: Promise<unknown>): Promise<BusRefusalCode | undefined> {
  try {
    await promise;
  } catch (error) {
    return isBusRefusal(error) ? error.code : undefined;
  }
  return undefined;
}

describe("createPauseLease", () => {
  test("@all is stored as [\"*\"], writes the lease file and its pause-request event together, with the default TTL", async () => {
    const root = await busRoot();
    const lease = await createPauseLease(root, {
      holder: HOLDER,
      toLabel: "@all",
      scope: "turns",
      reason: "cutting 0.2.130",
      ...clock,
    });

    expect(lease.targets).toEqual(["*"]);
    expect(lease.holder).toEqual(HOLDER);
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.createdAt)).toBe(DEFAULT_LEASE_TTL_MS);

    const onDisk = await readLease(root, lease.leaseId);
    expect(onDisk).toEqual(lease);

    const events = await allEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "pause-request",
      from: HOLDER,
      to: ["*"],
      toLabel: "@all",
      body: "cutting 0.2.130",
      refs: { leaseId: lease.leaseId },
    });
    expect(lease.requestEventSeq).toBe(events[0]!.seq);
  });

  test("an explicit ttlMs is honoured within [1 min, 4 h]", async () => {
    const root = await busRoot();
    const lease = await createPauseLease(root, {
      holder: HOLDER,
      toLabel: "@all",
      scope: "git-publish",
      reason: "tagging",
      ttlMs: 5 * MIN,
      ...clock,
    });
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.createdAt)).toBe(5 * MIN);
  });

  test("ttl-out-of-range: below 1 minute or above 4 hours is refused; the bounds themselves are accepted", async () => {
    const root = await busRoot();
    expect(
      await refusal(
        createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "x", ttlMs: MIN_LEASE_TTL_MS - 1, ...clock }),
      ),
    ).toBe("ttl-out-of-range");
    expect(
      await refusal(
        createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "x", ttlMs: MAX_LEASE_TTL_MS + 1, ...clock }),
      ),
    ).toBe("ttl-out-of-range");

    // The bounds themselves succeed (each with a fresh holder so `lease-already-held` cannot interfere).
    await createPauseLease(root, {
      holder: { ...HOLDER, instanceId: ID.other },
      toLabel: "@all",
      scope: "turns",
      reason: "x",
      ttlMs: MIN_LEASE_TTL_MS,
      ...clock,
    });
    await createPauseLease(root, {
      holder: { ...HOLDER, instanceId: ID.cli1, name: "cli", origin: "cli" },
      toLabel: "@all",
      scope: "turns",
      reason: "x",
      ttlMs: MAX_LEASE_TTL_MS,
      ...clock,
    });
  });

  test("the holder is never a target: an explicit @name resolving only to the holder is refused recipient-is-self", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.holder, "release", NOW, 100));
    expect(
      await refusal(createPauseLease(root, { holder: HOLDER, toLabel: "@release", scope: "turns", reason: "x", ...clock, liveness })),
    ).toBe("recipient-is-self");
  });

  test("an unknown or non-live @name is refused exactly like `resolveRecipients` refuses it", async () => {
    const root = await busRoot();
    expect(
      await refusal(createPauseLease(root, { holder: HOLDER, toLabel: "@nobody", scope: "turns", reason: "x", ...clock, liveness })),
    ).toBe("unknown-recipient");

    await writePresence(root, presence(ID.target, "dev", NOW - 60_000, 999)); // stale/gone: pid 999 is not alive
    expect(
      await refusal(createPauseLease(root, { holder: HOLDER, toLabel: "@dev", scope: "turns", reason: "x", ...clock, liveness })),
    ).toBe("recipient-not-live");
  });

  test("lease-already-held: one active lease per holder; ending it allows a new one", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.holder, "release", NOW, 100)); // live, so the first lease is judged active below
    const first = await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "first", ...clock, liveness });

    expect(
      await refusal(
        createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "advisory", reason: "second", ...clock, liveness }),
      ),
    ).toBe("lease-already-held");

    await resumePauseLease(root, { leaseId: first.leaseId, by: HOLDER, ...clock });
    const second = await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "third", ...clock, liveness });
    expect(second.leaseId).not.toBe(first.leaseId);
  });

  test("lease-already-held: at most one active CLI-origin lease per clone, regardless of the (fresh) holder id", async () => {
    const root = await busRoot();
    const cliHolder1: PauseLeaseActor = { instanceId: ID.cli1, name: "cli", origin: "cli" };
    const cliHolder2: PauseLeaseActor = { instanceId: ID.cli2, name: "cli", origin: "cli" };

    await createPauseLease(root, { holder: cliHolder1, toLabel: "@all", scope: "turns", reason: "x", ...clock });
    expect(
      await refusal(createPauseLease(root, { holder: cliHolder2, toLabel: "@all", scope: "turns", reason: "y", ...clock })),
    ).toBe("lease-already-held");

    // A non-CLI holder is unaffected by the clone-wide CLI limit.
    const agentLease = await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "z", ...clock });
    expect(agentLease.holder.origin).toBe("agent");
  });

  test("the event and the file land together: a refused create (lease-already-held) writes neither", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.holder, "release", NOW, 100)); // live, so the first lease is judged active below
    await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "first", ...clock, liveness });
    expect(
      await refusal(
        createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "second", ...clock, liveness }),
      ),
    ).toBe("lease-already-held");

    // Only the first create's own event and file exist — the refused attempt left no trace.
    expect(await allEvents(root)).toHaveLength(1);
  });
});

describe("resumePauseLease", () => {
  async function withLease(root: string, toLabel = "@all") {
    return createPauseLease(root, { holder: HOLDER, toLabel, scope: "turns", reason: "release", ...clock });
  }

  test("the holder can resume its own lease: writes resume addressed to the lease's targets, and deletes the file", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.target, "dev", NOW, 100));
    const lease = await withLease(root, "@dev");

    await resumePauseLease(root, { leaseId: lease.leaseId, by: HOLDER, ...clock });

    expect(await readLease(root, lease.leaseId)).toBeUndefined();
    const events = await allEvents(root);
    const resume = events.find((e) => e.kind === "resume");
    expect(resume).toMatchObject({ to: [ID.target], refs: { leaseId: lease.leaseId } });
  });

  test("not-lease-holder: a different instance may not resume someone else's lease, and the lease survives", async () => {
    const root = await busRoot();
    const lease = await withLease(root);
    const stranger: PauseLeaseActor = { instanceId: ID.other, name: "stranger", origin: "agent" };

    expect(await refusal(resumePauseLease(root, { leaseId: lease.leaseId, by: stranger, ...clock }))).toBe("not-lease-holder");
    expect(await readLease(root, lease.leaseId)).toBeDefined();
  });

  test("an operator through the CLI (origin cli) may resume any lease, holder or not", async () => {
    const root = await busRoot();
    const lease = await withLease(root);
    const cliOperator: PauseLeaseActor = { instanceId: ID.cli1, name: "cli", origin: "cli" };

    await resumePauseLease(root, { leaseId: lease.leaseId, by: cliOperator, ...clock });
    expect(await readLease(root, lease.leaseId)).toBeUndefined();
  });

  test("idempotent: resuming an already-ended or never-existing lease is a silent no-op", async () => {
    const root = await busRoot();
    const lease = await withLease(root);
    await resumePauseLease(root, { leaseId: lease.leaseId, by: HOLDER, ...clock });

    await resumePauseLease(root, { leaseId: lease.leaseId, by: HOLDER, ...clock }); // already gone
    await resumePauseLease(root, { leaseId: "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c", by: HOLDER, ...clock }); // never existed

    // Only the one real resume event was ever written.
    expect((await allEvents(root)).filter((e) => e.kind === "resume")).toHaveLength(1);
  });
});

describe("overridePauseLease", () => {
  test("writes an override event addressed to the lease's holder, and does NOT delete the file", async () => {
    const root = await busRoot();
    const lease = await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "release", ...clock });

    await overridePauseLease(root, { leaseId: lease.leaseId, by: { instanceId: ID.target }, ...clock });

    expect(await readLease(root, lease.leaseId)).toBeDefined(); // still active for other targets
    const events = await allEvents(root);
    const override = events.find((e) => e.kind === "override");
    expect(override).toMatchObject({
      from: { instanceId: ID.target, name: "system", origin: "system" },
      to: [ID.holder],
      toLabel: "@release",
      refs: { leaseId: lease.leaseId },
    });
  });

  test("a no-op when the lease is already gone", async () => {
    const root = await busRoot();
    await overridePauseLease(root, { leaseId: "5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d", by: { instanceId: ID.target }, ...clock });
    expect(await allEvents(root)).toHaveLength(0);
  });
});

describe("createLeaseView", () => {
  test("held()/heldBy()/banner() reflect an active turns lease targeting me; the holder is never held by its own lease", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.holder, "release", NOW, 100));
    const lease = await createPauseLease(root, {
      holder: HOLDER,
      toLabel: "@all",
      scope: "turns",
      reason: "cutting 0.2.130",
      ttlMs: 12 * MIN,
      ...clock,
      liveness,
    });

    const holderView = createLeaseView({ root, instanceId: ID.holder, ...clock, liveness });
    await holderView.refresh();
    expect(holderView.held()).toBe(false); // D-03: never targets its own holder

    const targetView = createLeaseView({ root, instanceId: ID.target, ...clock, liveness });
    await targetView.refresh();
    expect(targetView.held()).toBe(true);
    expect(targetView.heldBy()?.leaseId).toBe(lease.leaseId);
    expect(targetView.banner()).toBe('⏸ turns held by @release — "cutting 0.2.130" — 12m left · /bus override to continue');
  });

  test("override(leaseId) releases only that instance, immediately and without a refresh; other targets stay held", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.holder, "release", NOW, 100));
    const lease = await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "x", ...clock, liveness });

    const targetView = createLeaseView({ root, instanceId: ID.target, ...clock, liveness });
    await targetView.refresh();
    expect(targetView.held()).toBe(true);
    await targetView.override(lease.leaseId);
    expect(targetView.held()).toBe(false); // takes effect without another refresh

    const otherView = createLeaseView({ root, instanceId: ID.other, ...clock, liveness });
    await otherView.refresh();
    expect(otherView.held()).toBe(true); // unaffected by target's own override

    const events = await allEvents(root);
    expect(events.some((e) => e.kind === "override" && e.from.instanceId === ID.target)).toBe(true);
  });

  test("D-09: a stale holder (old heartbeat, live pid, same host) keeps the lease active; a gone holder does not", async () => {
    const root = await busRoot();
    // Heartbeat far older than the 15s presence window, but the pid is "alive".
    await writePresence(root, presence(ID.holder, "release", NOW - 10 * 60_000, 100));
    await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "x", now: () => NOW - 10 * 60_000, liveness });

    const view = createLeaseView({ root, instanceId: ID.target, ...clock, liveness });
    await view.refresh();
    expect(view.held()).toBe(true); // stale holder: lease stays active

    const goneView = createLeaseView({ root, instanceId: ID.target, ...clock, liveness: { host: "this-host", isAlive: () => false } });
    await goneView.refresh();
    expect(goneView.held()).toBe(false); // gone holder: lease is inactive
  });

  test("myLeases(): this instance's own active leases, and no one else's", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.holder, "release", NOW, 100));
    await writePresence(root, presence(ID.other, "reviewer", NOW, 100));
    const mine = await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "turns", reason: "x", ...clock, liveness });
    await createPauseLease(root, {
      holder: { instanceId: ID.other, name: "reviewer", origin: "agent" },
      toLabel: "@all",
      scope: "advisory",
      reason: "y",
      ...clock,
      liveness,
    });

    const view = createLeaseView({ root, instanceId: ID.holder, ...clock, liveness });
    await view.refresh();
    expect(view.myLeases().map((l) => l.leaseId)).toEqual([mine.leaseId]);
  });

  test("appliesToMe(scope) is scope-specific: a git-publish lease does not apply under \"turns\"", async () => {
    const root = await busRoot();
    await writePresence(root, presence(ID.holder, "release", NOW, 100));
    await createPauseLease(root, { holder: HOLDER, toLabel: "@all", scope: "git-publish", reason: "x", ...clock, liveness });

    const view = createLeaseView({ root, instanceId: ID.target, ...clock, liveness });
    await view.refresh();
    expect(view.appliesToMe("git-publish")).toBe(true);
    expect(view.appliesToMe("turns")).toBe(false);
    expect(view.held()).toBe(false);
  });
});

describe("exactly-once lease-expired stays with prune (specification §4.3, artifact-lifecycle.md)", () => {
  test("a lease created via createPauseLease expires naturally and pruneBus retires it exactly once", async () => {
    const root = await busRoot();
    // origin "cli" so expiry is judged by TTL alone (isLeaseActive never
    // consults holder liveness for a CLI holder) — isolates the TTL path from
    // D-09, which `./prune.test.ts` already covers on its own.
    const cliHolder: PauseLeaseActor = { instanceId: ID.cli1, name: "cli", origin: "cli" };
    const lease = await createPauseLease(root, {
      holder: cliHolder,
      toLabel: "@all",
      scope: "turns",
      reason: "x",
      ttlMs: MIN_LEASE_TTL_MS,
      ...clock,
    });

    const later = { now: () => NOW + MIN_LEASE_TTL_MS + 1_000, ...liveness };
    const [a, b] = await Promise.all([pruneBus(root, later), pruneBus(root, later)]);
    const expiredCount = [...a.leases, ...b.leases].filter((id) => id === lease.leaseId).length;
    expect(expiredCount).toBe(1);

    const events = await allEvents(root);
    expect(events.filter((e) => e.kind === "lease-expired" && e.refs?.leaseId === lease.leaseId)).toHaveLength(1);

    // Sanity: the surviving read-side helpers this module builds on agree it is gone.
    const stillThere = await readLease(root, lease.leaseId);
    expect(stillThere).toBeUndefined();
  });
});

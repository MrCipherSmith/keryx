// Flow 289, AC1/AC2 — a flow can name an owner, the owner is never inferred,
// and every change survives as history rather than as an overwrite.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-22T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<FlowService> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-owner-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService(makeDeps());
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function readRawFlow(dir: string): Promise<FlowState> {
  return JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8"),
  ) as FlowState;
}

// --- AC1 --------------------------------------------------------------------

test("AC1: `flow init --owner` records a stated identity", async () => {
  const service = await fresh();
  const { flow, dir } = await service.init({ cwd: ROOT, title: "Owned from the start", owner: "Aleks" });

  expect(flow.owner).toEqual({ value: "Aleks", basis: "stated", source: "`--owner` flag on `flow init`" });
  const raw = await readRawFlow(path.basename(dir));
  expect(raw.owner).toEqual({ value: "Aleks", basis: "stated", source: "`--owner` flag on `flow init`" });
});

test("AC1: a flow initialized without --owner reports owner as not set, never inferred", async () => {
  const service = await fresh();
  const { flow } = await service.init({ cwd: ROOT, title: "No owner named" });

  expect(flow.owner).toBeUndefined();
});

test("AC1: `flow owner set` refuses an empty owner", async () => {
  const service = await fresh();
  const { flow } = await service.init({ cwd: ROOT, title: "Needs an owner" });

  await expect(service.ownerSet({ cwd: ROOT, id: flow.id, owner: "", reason: "because" })).rejects.toThrow(
    /--owner/,
  );
});

test("AC1: `flow owner set` refuses an empty reason", async () => {
  const service = await fresh();
  const { flow } = await service.init({ cwd: ROOT, title: "Needs a reason" });

  await expect(
    service.ownerSet({ cwd: ROOT, id: flow.id, owner: "Aleks", reason: "" }),
  ).rejects.toThrow(/--reason/);
});

test("AC1: `flow owner set` sets a fresh owner as stated", async () => {
  const service = await fresh();
  const { flow } = await service.init({ cwd: ROOT, title: "Assign after init" });

  const updated = await service.ownerSet({
    cwd: ROOT,
    id: flow.id,
    owner: "Priya",
    reason: "she picked up the flow",
  });

  expect(updated.owner).toEqual({ value: "Priya", basis: "stated", source: "`--owner` flag on `flow owner set`" });
});

// --- AC2 --------------------------------------------------------------------

test("AC2: changing the owner twice keeps both earlier values in history, not just the latest", async () => {
  const service = await fresh();
  const { flow, dir } = await service.init({ cwd: ROOT, title: "Owner changes twice", owner: "Aleks" });

  await service.ownerSet({ cwd: ROOT, id: flow.id, owner: "Priya", reason: "handoff 1" });
  const final = await service.ownerSet({ cwd: ROOT, id: flow.id, owner: "Jordan", reason: "handoff 2" });

  expect(final.owner?.value).toBe("Jordan");

  // `init`'s own owner assignment is not an `ownerSet` call and writes no
  // owner-change history event (only "created" does); the two explicit
  // `ownerSet` calls below are the only owner-change events, and both must
  // survive — not just the latest.
  const ownerEvents = final.history.filter((event) => event.event === "owner-set" || event.event === "owner-changed");
  expect(ownerEvents).toHaveLength(2);
  // The two ownerSet-driven transitions are both visible, each naming its own
  // previous value — "Aleks -> Priya" is not overwritten by "Priya -> Jordan".
  expect(ownerEvents.some((event) => event.detail?.includes("Aleks -> Priya"))).toBe(true);
  expect(ownerEvents.some((event) => event.detail?.includes("Priya -> Jordan"))).toBe(true);

  // And the same is true after a fresh read from disk — this is not an
  // in-memory-only property.
  const raw = await readRawFlow(path.basename(dir));
  const rawOwnerEvents = raw.history.filter(
    (event) => event.event === "owner-set" || event.event === "owner-changed",
  );
  expect(rawOwnerEvents.some((event) => event.detail?.includes("Aleks -> Priya"))).toBe(true);
  expect(rawOwnerEvents.some((event) => event.detail?.includes("Priya -> Jordan"))).toBe(true);
  expect(raw.owner?.value).toBe("Jordan");
});

test("AC2: no code path rewrites or deletes an earlier owner-change history entry", async () => {
  const service = await fresh();
  const { flow } = await service.init({ cwd: ROOT, title: "History is append-only" });

  const afterFirst = await service.ownerSet({ cwd: ROOT, id: flow.id, owner: "Aleks", reason: "first" });
  const firstLength = afterFirst.history.length;
  const afterSecond = await service.ownerSet({ cwd: ROOT, id: flow.id, owner: "Priya", reason: "second" });

  expect(afterSecond.history.length).toBe(firstLength + 1);
  // Every entry present after the first change is still present, unchanged,
  // after the second.
  for (let i = 0; i < firstLength; i++) {
    expect(afterSecond.history[i]).toEqual(afterFirst.history[i]);
  }
});

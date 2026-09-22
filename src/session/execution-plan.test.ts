import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSlate, readSlate, writeSlate, type Slate } from "./slate";
import { openSlate } from "./slate-lifecycle";
import {
  executionPlanApprovalItems,
  executionPlanPath,
  getExecutionPlan,
  hasActionableExecutionPlanItems,
  setExecutionPlan,
  updateExecutionPlan,
  type ExecutionPlanItem,
} from "./execution-plan";

const baseSlate = (): Slate => ({ anchors: { root: ".", touched: [] }, course: {}, seeds: [] });

/** A bare session dir — no `slate.json`, and for the decoupling tests never one. */
async function bareDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keryx-execution-plan-"));
}

/** A session dir WITH a slate — the plan's pre-decoupling home. */
async function sessionDir(): Promise<string> {
  const dir = await bareDir();
  await writeSlate(dir, () => baseSlate());
  return dir;
}

/**
 * The legacy field, read STRUCTURALLY: the `Slate` type no longer declares
 * `executionPlan` (that removal is the change under test), so asserting its
 * absence has to go through an explicit shape rather than the type.
 */
async function legacyPlanInSlate(dir: string): Promise<unknown> {
  const slate = (await readSlate(dir)) as { executionPlan?: unknown } | undefined;
  return slate?.executionPlan;
}

const items: ExecutionPlanItem[] = [
  { id: "inspect", title: "Inspect the current behavior", status: "completed" },
  { id: "implement", title: "Implement the change", status: "in_progress" },
  { id: "verify", title: "Verify the result", status: "pending" },
];

test("setExecutionPlan persists stable item ids in the plan's OWN file, never inside slate.json", async () => {
  const dir = await sessionDir();
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });

  expect(created.revision).toBe(1);
  expect(created.items.map((item) => item.id)).toEqual(["inspect", "implement", "verify"]);
  expect(await getExecutionPlan(dir)).toEqual(created);
  expect(JSON.parse(await readFile(executionPlanPath(dir), "utf8"))).toEqual(created);
  // The regression this decoupling exists for: the plan is not a Slate field,
  // so nothing a Slate does can take it away.
  expect(await legacyPlanInSlate(dir)).toBeUndefined();
});

test("REGRESSION: a session with NO slate at all can publish, read and update a plan", async () => {
  const dir = await bareDir();
  expect(await readSlate(dir)).toBeUndefined();

  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });
  expect(created.revision).toBe(1);
  expect(await getExecutionPlan(dir)).toEqual(created);

  // `blocked`, not `in_progress`: `implement` is already the plan's single
  // active item, and `validateItems` correctly refuses a second one — that rule
  // is not what this test is about.
  const progressed = await updateExecutionPlan(dir, {
    expectedRevision: created.revision,
    itemId: "verify",
    status: "blocked",
  });
  expect(progressed.revision).toBe(2);
  expect(progressed.items.find((item) => item.id === "verify")?.status).toBe("blocked");
  // Writing a plan opened no slate on the side.
  expect(await readSlate(dir)).toBeUndefined();
});

test("REGRESSION: closing the Slate (archive-on-flow-done) no longer destroys the plan", async () => {
  const dir = await sessionDir();
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });

  await archiveSlate(dir, "flow-done-1"); // exactly what closeSlateOnFlowDone does
  expect(await readSlate(dir)).toBeUndefined();

  expect(await getExecutionPlan(dir)).toEqual(created);
  const after = await updateExecutionPlan(dir, {
    expectedRevision: created.revision,
    itemId: "implement",
    status: "completed",
  });
  expect(after.revision).toBe(2);
});

test("a plan stored the old way (inside slate.json) is still read, and migrates on the first write", async () => {
  const dir = await bareDir();
  const legacy = { revision: 3, items };
  await writeSlate(dir, () => ({ ...baseSlate(), executionPlan: legacy }));

  expect(await getExecutionPlan(dir)).toEqual(legacy);

  const next = await updateExecutionPlan(dir, { expectedRevision: 3, itemId: "verify", status: "completed" });
  expect(next.revision).toBe(4);
  // Migrated: the new revision lives in plan.json; the slate keeps the old copy.
  expect((JSON.parse(await readFile(executionPlanPath(dir), "utf8")) as { revision: number }).revision).toBe(4);
  expect(await legacyPlanInSlate(dir)).toEqual(legacy);
});

test("a Slate written before execution plans existed remains readable and has no plan", async () => {
  const dir = await sessionDir();
  expect(await getExecutionPlan(dir)).toBeUndefined();
  expect(await readSlate(dir)).toEqual(baseSlate());
});

test("a plan survives a slate reopen (resume) without the Slate having to carry it", async () => {
  const dir = await sessionDir();
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });
  const reopened = await openSlate({ dir, cwd: dir, mintAttemptId: () => "resume-1" });
  expect((reopened as unknown as { executionPlan?: unknown }).executionPlan).toBeUndefined();
  expect(await getExecutionPlan(dir)).toEqual(created);
});

test("`proposed` is a real status, and a plan published for approval is NOT actionable work", async () => {
  const dir = await sessionDir();
  const awaiting = await setExecutionPlan(dir, {
    expectedRevision: 0,
    items: [
      { id: "t1", title: "Add the audit log", status: "proposed" },
      { id: "t2", title: "Backfill the entries", status: "proposed" },
    ],
  });
  expect(await getExecutionPlan(dir)).toEqual(awaiting);
  // The whole point: this is where the agent may STOP and wait for a human.
  expect(hasActionableExecutionPlanItems(awaiting)).toBe(false);
  expect(executionPlanApprovalItems(awaiting).map((item) => item.id)).toEqual(["t1", "t2"]);

  // An approved item becomes real work again.
  const approved = await updateExecutionPlan(dir, {
    expectedRevision: awaiting.revision,
    itemId: "t1",
    status: "pending",
  });
  expect(hasActionableExecutionPlanItems(approved)).toBe(true);
  expect(executionPlanApprovalItems(approved).map((item) => item.id)).toEqual(["t2"]);

  // …and work in progress always was.
  expect(hasActionableExecutionPlanItems({ revision: 9, items: [{ id: "x", title: "x", status: "in_progress" }] })).toBe(true);
  expect(hasActionableExecutionPlanItems(undefined)).toBe(false);
});

test("an unknown status is still rejected — the new member did not loosen validation", async () => {
  const dir = await sessionDir();
  await expect(
    setExecutionPlan(dir, {
      expectedRevision: 0,
      items: [{ id: "bad", title: "Bad", status: "awaiting-approval" as ExecutionPlanItem["status"] }],
    }),
  ).rejects.toThrow(/status/i);
});

test("a corrupt plan.json degrades to 'no plan' instead of wedging every plan tool call", async () => {
  const dir = await sessionDir();
  await writeFile(executionPlanPath(dir), "{ not json", "utf8");
  expect(await getExecutionPlan(dir)).toBeUndefined();
  // And the next write still succeeds, replacing the corrupt file.
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });
  expect(created.revision).toBe(1);
});

test("setExecutionPlan rejects duplicate ids, invalid statuses, and multiple in-progress items", async () => {
  const dir = await sessionDir();

  await expect(
    setExecutionPlan(dir, { expectedRevision: 0, items: [items[0]!, { ...items[1]!, id: "inspect" }] }),
  ).rejects.toThrow(/duplicate|id/i);
  await expect(
    setExecutionPlan(dir, {
      expectedRevision: 0,
      items: [{ id: "bad", title: "Bad status", status: "working" as ExecutionPlanItem["status"] }],
    }),
  ).rejects.toThrow(/status/i);
  await expect(
    setExecutionPlan(dir, {
      expectedRevision: 0,
      items: [items[1]!, { id: "second", title: "Second active item", status: "in_progress" }],
    }),
  ).rejects.toThrow(/in_progress|progress/i);
});

test("updateExecutionPlan preserves ids, supports every terminal state, and rejects stale revisions visibly", async () => {
  const dir = await sessionDir();
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });
  const completed = await updateExecutionPlan(dir, {
    expectedRevision: created.revision,
    itemId: "implement",
    status: "completed",
  });
  expect(completed.revision).toBe(2);
  expect(completed.items.map((item) => item.id)).toEqual(items.map((item) => item.id));

  const blocked = await updateExecutionPlan(dir, {
    expectedRevision: completed.revision,
    itemId: "verify",
    status: "blocked",
  });
  expect(blocked.items.find((item) => item.id === "verify")?.status).toBe("blocked");

  const skipped = await updateExecutionPlan(dir, {
    expectedRevision: blocked.revision,
    itemId: "verify",
    status: "skipped",
  });
  expect(skipped.items.find((item) => item.id === "verify")?.status).toBe("skipped");

  await expect(
    updateExecutionPlan(dir, { expectedRevision: created.revision, itemId: "verify", status: "pending" }),
  ).rejects.toThrow(/revision|conflict|stale/i);
});

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSlate, writeSlate, type Slate } from "./slate";
import { openSlate } from "./slate-lifecycle";
import {
  getExecutionPlan,
  setExecutionPlan,
  updateExecutionPlan,
  type ExecutionPlanItem,
} from "./execution-plan";

const baseSlate = (): Slate => ({ anchors: { root: ".", touched: [] }, course: {}, seeds: [] });

async function sessionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keryx-execution-plan-"));
  await writeSlate(dir, () => baseSlate());
  return dir;
}

const items: ExecutionPlanItem[] = [
  { id: "inspect", title: "Inspect the current behavior", status: "completed" },
  { id: "implement", title: "Implement the change", status: "in_progress" },
  { id: "verify", title: "Verify the result", status: "pending" },
];

test("setExecutionPlan persists stable item ids in Slate and getExecutionPlan restores them", async () => {
  const dir = await sessionDir();
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });

  expect(created.revision).toBe(1);
  expect(created.items.map((item) => item.id)).toEqual(["inspect", "implement", "verify"]);
  expect(await getExecutionPlan(dir)).toEqual(created);
  expect((await readSlate(dir))?.executionPlan).toEqual(created);
});

test("a Slate written before execution plans existed remains readable and has no plan", async () => {
  const dir = await sessionDir();
  expect(await getExecutionPlan(dir)).toBeUndefined();
  expect(await readSlate(dir)).toEqual(baseSlate());
});

test("an existing execution plan is restored when the Slate is reopened on resume", async () => {
  const dir = await sessionDir();
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items });
  const reopened = await openSlate({ dir, cwd: dir, mintAttemptId: () => "resume-1" });
  expect(reopened.executionPlan).toEqual(created);
  expect(await getExecutionPlan(dir)).toEqual(created);
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

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionPlan } from "../session/execution-plan";
import { projectExecutionPlanPanel } from "./execution-plan-panel";

const plan = (active: number, count = 10): ExecutionPlan => ({
  revision: 4,
  items: Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    title: `Plan item ${index} with a deliberately long title`,
    status: index === active ? "in_progress" : index < active ? "completed" : "pending",
  })),
});

test("the Plan projection is hidden when empty and caps a populated plan at seven centered rows", () => {
  expect(projectExecutionPlanPanel(undefined, { width: 26, maxRows: 7 })).toEqual({
    visible: false,
    rows: [],
    revision: undefined,
  });
  expect(projectExecutionPlanPanel({ revision: 3, items: [] }, { width: 26, maxRows: 7 })).toEqual({
    visible: false,
    rows: [],
    revision: undefined,
  });

  const projected = projectExecutionPlanPanel(plan(5), { width: 26, maxRows: 7 });
  expect(projected.visible).toBe(true);
  expect(projected.rows).toHaveLength(7);
  expect(projected.rows.map((row) => row.id)).toEqual([
    "item-2",
    "item-3",
    "item-4",
    "item-5",
    "item-6",
    "item-7",
    "item-8",
  ]);
  expect(projected.rows[3]?.status).toBe("in_progress");
  expect(projected.rows.every((row) => row.text.length <= 26)).toBe(true);
});

test("the Plan projection distinguishes all five states and changes its repaint revision only with plan state", () => {
  const fiveStates: ExecutionPlan = {
    revision: 9,
    items: ["completed", "in_progress", "pending", "blocked", "skipped"].map((status, index) => ({
      id: `state-${index}`,
      title: status,
      status: status as ExecutionPlan["items"][number]["status"],
    })),
  };
  const projected = projectExecutionPlanPanel(fiveStates, { width: 26, maxRows: 7 });

  expect(new Set(projected.rows.map((row) => row.glyph)).size).toBe(5);
  expect(projected.revision).toBe(9);
  expect(projectExecutionPlanPanel(fiveStates, { width: 26, maxRows: 7 }).revision).toBe(projected.revision);
});

test("tui-shell mounts the conditional Plan panel immediately before Background Jobs", () => {
  const source = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  const planMount = source.indexOf("const executionPlanPanel = mountExecutionPlanPanel");
  const jobsMount = source.indexOf("const sbJobs = new otui.BoxRenderable", planMount);

  expect(planMount).toBeGreaterThanOrEqual(0);
  expect(jobsMount).toBeGreaterThan(planMount);
});

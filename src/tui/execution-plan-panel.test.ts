import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setExecutionPlan, type ExecutionPlan } from "../session/execution-plan";
import { mountExecutionPlanPanel, projectExecutionPlanPanel } from "./execution-plan-panel";

const item_row = (id: string, status: ExecutionPlan["items"][number]["status"]): ExecutionPlan["items"][number] => ({
  id,
  title: `${id} title`,
  status,
});

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

test("a proposed plan gets its own glyph, and the window follows the first thing still to do", () => {
  const awaiting: ExecutionPlan = {
    revision: 2,
    items: [item_row("a", "proposed"), item_row("b", "proposed")],
  };
  expect(projectExecutionPlanPanel(awaiting, { width: 26, maxRows: 7 }).rows.map((row) => row.glyph)).toEqual([
    "◇",
    "◇",
  ]);

  // Nothing in progress, work at the far end: the window must NOT sit on the
  // head of the list (the "sidebar looks frozen" cause), it follows the first
  // `pending` item.
  const long: ExecutionPlan = {
    revision: 3,
    items: Array.from({ length: 12 }, (_, index) => item_row(`i${index}`, index < 9 ? "completed" : "pending")),
  };
  const rows = projectExecutionPlanPanel(long, { width: 26, maxRows: 7 }).rows;
  expect(rows.map((row) => row.id)).toContain("i9");
  expect(rows.map((row) => row.id)).not.toContain("i0");
});

test("the Plan section is ONE click target: the header carries the revision and every row opens the inspector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-plan-click-"));
  const first = await setExecutionPlan(dir, {
    expectedRevision: 0,
    items: [
      { id: "t1", title: "First", status: "completed" },
      { id: "t2", title: "Second", status: "pending" },
    ],
  });

  type Painted = { id: string; content: string; onMouseDown?: () => void };
  const painted: Painted[] = [];
  const parent = {
    add: (child: unknown) => painted.push(child as Painted),
    getChildren: () => [...painted],
    remove: (child: unknown) => {
      const index = painted.indexOf(child as Painted);
      if (index >= 0) painted.splice(index, 1);
    },
  };
  const otui = {
    TextRenderable: class {
      id: string;
      content: string;
      onMouseDown: (() => void) | undefined;
      constructor(_r: unknown, o: { id: string; content: string; onMouseDown?: () => void }) {
        this.id = o.id;
        this.content = o.content;
        this.onMouseDown = o.onMouseDown;
      }
    },
  };

  let opened = 0;
  mountExecutionPlanPanel(otui, {}, parent, {
    getSessionDir: () => dir,
    width: 26,
    maxRows: 7,
    onOpen: () => {
      opened += 1;
    },
  });
  // The mount's own first read is async; let it settle so the repaint below is
  // the only thing that touches the rows (no write/read interleaving).
  await new Promise((resolve) => setTimeout(resolve, 30));

  // A live plan write repaints synchronously through the same subscription the
  // inspector uses — after which the rows are the ones a click would land on.
  await setExecutionPlan(dir, {
    expectedRevision: first.revision,
    items: [
      { id: "t1", title: "First", status: "completed" },
      { id: "t2", title: "Second", status: "in_progress" },
      { id: "t3", title: "Third", status: "pending" },
    ],
  });

  const header = painted.find((node) => node.id === "sb-plan-h");
  // `sb-plan-h` shares the prefix with the rows, so the header is excluded by
  // id rather than by a second, drifting prefix.
  const rows = painted.filter((node) => node.id.startsWith("sb-plan-") && node.id !== "sb-plan-h");
  expect(header?.content).toBe("Plan · rev 2");
  expect(rows).toHaveLength(3);
  expect(rows[1]?.content).toContain("Second");

  header?.onMouseDown?.();
  for (const row of rows) {
    row.onMouseDown?.();
  }
  // Header + every row: no dead area inside the section.
  expect(opened).toBe(rows.length + 1);
});

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setExecutionPlan,
  updateExecutionPlan,
  type ExecutionPlan,
  type ExecutionPlanStatus,
} from "../session/execution-plan";
import {
  PLAN_EMPTY_TEXT,
  formatPlanLegend,
  formatPlanRow,
  formatPlanSummary,
  planCounts,
  planProgressBar,
  presentExecutionPlanInspector,
  stylePlanText,
  type PlanModalInput,
} from "./execution-plan-inspector";

const item = (id: string, status: ExecutionPlanStatus, title = `${id} title`) => ({ id, title, status });

const mixedPlan = (revision = 3): ExecutionPlan => ({
  revision,
  items: [
    item("t1", "completed", "Inspect the current behavior"),
    item("t2", "in_progress", "Implement the change"),
    item("t3", "pending", "Verify the result"),
    item("t4", "blocked", "Wait for the credential"),
    item("t5", "skipped", "Drop the legacy path"),
  ],
});

type Node = { id: string; content: unknown };

function fakeOtui(): { TextRenderable: new (r: unknown, o: { id: string; content: unknown; marginTop?: number; onMouseDown?: () => void }) => Node } {
  return {
    TextRenderable: class {
      id: string;
      content: unknown;
      onMouseDown: (() => void) | undefined;
      constructor(_r: unknown, o: { id: string; content: unknown; marginTop?: number; onMouseDown?: () => void }) {
        this.id = o.id;
        this.content = o.content;
        this.onMouseDown = o.onMouseDown;
      }
    },
  };
}

/**
 * A modal host stand-in that keeps the SAME body object across tab switches —
 * which is what the real host does (one `body` is reused), and the reason the
 * inspector must repaint rather than keep nodes from a previous tab.
 */
function fakeHost(): {
  open: (otui: unknown, chrome: unknown, input: PlanModalInput) => {
    close: () => void;
    setTab: (id: string) => void;
    activeTab: () => string;
  };
  nodes: () => Node[];
  input: () => PlanModalInput;
} {
  let captured: PlanModalInput | undefined;
  let nodes: Node[] = [];
  let active = "plan";
  const body = {
    add: (child: Node) => nodes.push(child),
    getChildren: () => [...nodes],
    remove: (child: Node) => {
      nodes = nodes.filter((node) => node !== child);
    },
  };
  return {
    nodes: () => nodes,
    input: () => captured as PlanModalInput,
    open: (_otui, _chrome, input) => {
      captured = input;
      active = input.initialTab ?? "plan";
      input.renderTab(active, body);
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
          input.renderTab(id, body);
        },
        activeTab: () => active,
      };
    },
  };
}

const textOf = (nodes: Node[], id: string): string | undefined => {
  const node = nodes.find((candidate) => candidate.id === id);
  return node === undefined ? undefined : String(node.content);
};

test("the summary names the revision and the done count, and omits states at zero", () => {
  expect(formatPlanSummary(mixedPlan())).toBe(
    "Plan · revision 3 · 1/5 done · 1 in progress · 1 blocked · 1 pending · 1 skipped",
  );
  // Zero counts are omitted, not printed as "0 in progress" noise.
  expect(formatPlanSummary({ revision: 7, items: [item("a", "completed")] })).toBe("Plan · revision 7 · 1/1 done");
  expect(formatPlanSummary(undefined)).toBe("Plan · nothing published yet");
});

test("the progress bar fills by completed items only and never overflows its width", () => {
  expect(planProgressBar({ revision: 1, items: [item("a", "completed"), item("b", "pending")] }, 4)).toBe("▰▰▱▱");
  expect(planProgressBar({ revision: 1, items: [] }, 4)).toBe("▱▱▱▱");
  // A ten-item plan with five done fills exactly half, never one cell more.
  const half: ExecutionPlan = {
    revision: 2,
    items: Array.from({ length: 10 }, (_, index) => item(`i${index}`, index < 5 ? "completed" : "pending")),
  };
  expect(planProgressBar(half, 10)).toBe("▰▰▰▰▰▱▱▱▱▱");
});

test("a row spells the status out and keeps the agent's own title", () => {
  expect(formatPlanRow(item("t2", "in_progress", "Implement the change"))).toBe("▶ in progress  Implement the change");
  expect(formatPlanRow(item("t4", "blocked", "Wait"))).toBe("! blocked      Wait");
});

test("counts and the legend cover all five states", () => {
  const counts = planCounts(mixedPlan());
  expect(counts).toEqual({ completed: 1, in_progress: 1, pending: 1, blocked: 1, skipped: 1 });
  for (const word of ["completed", "in progress", "pending", "blocked", "skipped"]) {
    expect(formatPlanLegend()).toContain(word);
  }
});

test("the modal paints the summary, the bar, the legend and one row per item", () => {
  const host = fakeHost();
  presentExecutionPlanInspector(host.open, fakeOtui(), {}, { getSessionDir: () => "/tmp/session", initial: mixedPlan() });
  const nodes = host.nodes();

  expect(textOf(nodes, "plan-summary")).toContain("revision 3");
  expect(textOf(nodes, "plan-bar")).toBe("▰▰▱▱▱▱▱▱▱▱▱▱  1/5");
  expect(textOf(nodes, "plan-legend")).toContain("in progress");
  // EVERY item — the sidebar can only fit seven, and centers them; this list is
  // the whole plan.
  expect(nodes.filter((node) => node.id.startsWith("plan-item-")).map((node) => node.id)).toEqual([
    "plan-item-t1",
    "plan-item-t2",
    "plan-item-t3",
    "plan-item-t4",
    "plan-item-t5",
  ]);
  expect(textOf(nodes, "plan-item-t2")).toBe("▶ in progress  Implement the change");
  expect(textOf(nodes, "plan-item-t4")).toBe("! blocked      Wait for the credential");
  expect(host.input().title).toBe("/plan");
});

test("the Meta tab reports the revision, the active item, blocked ids and where the plan lives", () => {
  const host = fakeHost();
  const handle = presentExecutionPlanInspector(host.open, fakeOtui(), {}, { getSessionDir: () => "/tmp/session", initial: mixedPlan() });
  handle?.setTab("meta");
  const meta = textOf(host.nodes(), "plan-meta") ?? "";

  expect(meta).toContain("Revision  3");
  expect(meta).toContain("Active    t2 — Implement the change");
  expect(meta).toContain("Blocked   t4");
  expect(meta).toContain("plan.json");
  expect(meta).toContain("/tmp/session");
  // Switching tabs repaints the SAME body — no stale Plan rows left behind.
  expect(host.nodes().some((node) => node.id.startsWith("plan-item-"))).toBe(false);
});

test("a live plan_set/update repaints an OPEN modal — the sidebar's subscription, one more subscriber", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-plan-inspector-"));
  const created = await setExecutionPlan(dir, {
    expectedRevision: 0,
    items: [item("t1", "in_progress", "First"), item("t2", "pending", "Second")],
  });
  const host = fakeHost();
  presentExecutionPlanInspector(host.open, fakeOtui(), {}, { getSessionDir: () => dir, initial: created });
  expect(host.nodes().some((node) => node.id === "plan-item-t2")).toBe(true);

  await setExecutionPlan(dir, {
    expectedRevision: created.revision,
    items: [item("t1", "completed", "First"), item("t2", "in_progress", "Second"), item("t3", "pending", "Third")],
  });

  expect(host.nodes().some((node) => node.id === "plan-item-t3")).toBe(true);
  expect(textOf(host.nodes(), "plan-item-t1")).toBe("✓ completed    First");
  expect(textOf(host.nodes(), "plan-summary")).toContain("revision 2");
});

test("closing the modal unsubscribes — a later plan write repaints nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-plan-inspector-closed-"));
  const created = await setExecutionPlan(dir, { expectedRevision: 0, items: [item("t1", "in_progress")] });
  const host = fakeHost();
  const handle = presentExecutionPlanInspector(host.open, fakeOtui(), {}, { getSessionDir: () => dir, initial: created });
  const before = host.nodes().length;
  handle?.close();

  await updateExecutionPlan(dir, { expectedRevision: created.revision, itemId: "t1", status: "completed" });

  expect(host.nodes()).toHaveLength(before);
});

test("a session with no plan renders the empty state instead of an empty box", () => {
  const host = fakeHost();
  presentExecutionPlanInspector(host.open, fakeOtui(), {}, { getSessionDir: () => "/tmp/session", initial: undefined });
  expect(textOf(host.nodes(), "plan-empty")).toBe(PLAN_EMPTY_TEXT);
  expect(textOf(host.nodes(), "plan-summary")).toContain("nothing published yet");
});

test("styling degrades to plain text when the host has no style helpers", () => {
  // A headless host (and every test above) hands us exactly this much.
  expect(stylePlanText({}, "▶ in progress  X", "cyan")).toBe("▶ in progress  X");
  expect(stylePlanText(undefined, "plain", "plain")).toBe("plain");
});

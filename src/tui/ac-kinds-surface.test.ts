// Acceptance layer W0, AC13 — the flow surface that lists a flow's acceptance
// criteria (the AC tab of `/flows`, and `/ac`) renders each criterion's kind, and
// the freeze distribution line is visible there. Asserted on the ROWS the modal
// paints, not only on the formatter that feeds them.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { formatAcKindLines } from "./ac-kinds-surface";
import { presentFlows } from "./flow-inspector";
import { loadInspectorFlows, type FlowInspectorItem } from "./inspector-sources";

const BASE: FlowInspectorItem = {
  id: "361",
  slug: "acceptance-layer-w0",
  title: "Acceptance layer W0",
  status: "ready",
  dir: ".metaproject/flows/361-acceptance-layer-w0",
  tasksDone: 0,
  tasksTotal: 0,
  sessionIds: [],
  prUrl: null,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  source: "description",
  tasks: [],
};

const CLASSIFIED: FlowInspectorItem = {
  ...BASE,
  acKinds: {
    AC1: { kind: "exec", check: "bun test src/a.test.ts" },
    AC2: { kind: "invariant", check: "bun test src/b.test.ts" },
    AC3: { kind: "judged" },
    AC4: { kind: "none", reason: "a judgement" },
    AC5: { kind: "unclassified" },
  },
};

/** Open the modal on the AC tab with a fake host and return what it painted. */
function paintedAcTab(item: FlowInspectorItem, visibleRows = 20): string {
  let painted = "";
  presentFlows(
    (_otui, _chrome, input) => {
      input.renderTab("ac", {
        add: (child: { content?: string }) => {
          painted = (child as { content: string }).content;
        },
      });
      return { close: () => input.onClose?.(), setTab: () => {}, activeTab: () => "ac" };
    },
    {
      TextRenderable: class {
        content: string;
        constructor(_r: unknown, opts: { content: string }) {
          this.content = opts.content;
        }
      },
    },
    {},
    { items: [item], initialTab: "ac", visibleRows },
  );
  return painted;
}

describe("the AC tab renders each criterion's kind", () => {
  test("one painted row per criterion, carrying its kind and its check or reason", () => {
    const rows = paintedAcTab(CLASSIFIED).split("\n");
    expect(rows).toContain("AC1  exec `bun test src/a.test.ts`");
    expect(rows).toContain("AC2  invariant `bun test src/b.test.ts`");
    expect(rows).toContain("AC3  judged");
    expect(rows).toContain("AC4  none — a judgement");
    expect(rows).toContain("AC5  unclassified");
  });

  test("the freeze distribution line is visible on the same tab", () => {
    const painted = paintedAcTab(CLASSIFIED);
    expect(painted).toContain("acceptance kinds: exec 1  invariant 1  judged 1  none 1  unclassified 1   (5 criteria)");
    expect(painted).toContain("coverage: 2/5 runnable (40%)");
  });

  test("the cached check markers still render below the kinds", () => {
    const painted = paintedAcTab({
      ...CLASSIFIED,
      acMarkers: [{ id: "AC1", status: "likely-met", label: "likely met" }],
      acCheckedAt: "2026-09-28T00:00:00.000Z",
    });
    expect(painted).toContain("AC1  exec `bun test src/a.test.ts`");
    expect(painted).toContain("AC1  [met]");
    expect(painted.indexOf("AC1  exec")).toBeLessThan(painted.indexOf("AC1  [met]"));
  });

  test("a flow frozen before kinds existed says so instead of listing nothing", () => {
    const painted = paintedAcTab(BASE);
    expect(painted).toContain("Verification kinds: not recorded");
    expect(painted).not.toContain("none");
    expect(painted).not.toContain("(no criteria)");
  });

  test("a flow whose criteria are not frozen yet says so, not that it predates kinds", () => {
    const painted = paintedAcTab({ ...BASE, acFrozen: false });
    expect(painted).toContain("not frozen yet");
    expect(painted).not.toContain("frozen before kinds existed");
  });

  test("formatAcKindLines is the same block the CLI prints", () => {
    const lines = formatAcKindLines(CLASSIFIED);
    expect(lines[0]).toStartWith("acceptance kinds:");
    expect(lines[1]).toStartWith("coverage:");
    expect(lines).toContain("");
  });
});

describe("loadInspectorFlows carries the derived kinds", () => {
  test("a frozen flow's acKinds reach the item; a stripped one has none", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-ac-kinds-tui-"));
    try {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      const service = createFlowService({
        tracker: null,
        healthGate: async () => ({ status: "pass", reasons: [] }),
        now: () => new Date("2026-09-28T10:00:00Z"),
      });
      const { flow, dir } = await service.init({ cwd: root, title: "Kinds in the TUI" });
      await writeFile(
        path.join(root, ".metaproject", "flows", path.basename(dir), "acceptance-criteria.md"),
        "# Acceptance Criteria\n\n## Criteria\n\n- AC1: runs [verify: exec `bun test a`]\n- AC2: plain\n",
        "utf8",
      );
      await service.freeze({ cwd: root, id: flow.id });

      const [item] = await loadInspectorFlows(root);
      expect(item?.acKinds?.["AC1"]).toEqual({ kind: "exec", check: "bun test a" });
      expect(item?.acKinds?.["AC2"]).toEqual({ kind: "unclassified" });
      expect(item ? formatAcKindLines(item).join("\n") : "").toContain("AC1  exec `bun test a`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

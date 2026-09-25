import { expect, test } from "bun:test";
import type { FlowInspectorItem } from "./inspector-sources";
import {
  clampScroll,
  findFlowItem,
  formatAcCheckLines,
  formatAcMarkersSummary,
  formatFlowDetailLines,
  formatFlowListLines,
  formatFlowListText,
  isAcCommand,
  isFlowsCommand,
  presentFlows,
  windowLines,
} from "./flow-inspector";

const ITEM: FlowInspectorItem = {
  id: "154",
  slug: "tui-modal-chrome",
  title: "Modal chrome",
  status: "in-progress",
  dir: ".metaproject/flows/154-tui-modal-chrome",
  tasksDone: 2,
  tasksTotal: 4,
  sessionIds: [],
  prUrl: "https://example.test/pr/1",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T01:00:00.000Z",
  source: "description",
  tasks: [{ id: "T1", title: "Chrome", status: "done" }],
};

test("isFlowsCommand accepts only /flows", () => {
  expect(isFlowsCommand("/flows")).toBe(true);
  expect(isFlowsCommand("  /flows 154")).toBe(true);
  expect(isFlowsCommand("/flow")).toBe(false);
  expect(isFlowsCommand("/status")).toBe(false);
});

test("list highlights the selected row; detail includes tasks", () => {
  expect(formatFlowListLines([ITEM], 0)[0]?.startsWith("> ")).toBe(true);
  expect(formatFlowListLines([ITEM], 1)[0]?.startsWith("  ")).toBe(true);
  const detail = formatFlowDetailLines(ITEM).join("\n");
  expect(detail).toContain("154");
  expect(detail).toContain("Modal chrome");
  expect(detail).toContain("T1");
  expect(detail).toContain("https://example.test/pr/1");
});

test("findFlowItem resolves padded ids and slugs", () => {
  expect(findFlowItem([ITEM], "154")?.id).toBe("154");
  expect(findFlowItem([ITEM], "tui-modal-chrome")?.id).toBe("154");
  expect(findFlowItem([ITEM], "missing")).toBeUndefined();
});

test("presentFlows opens list+detail and Enter switches to Detail", () => {
  const calls: { title: string; tabs: readonly { id: string }[]; initialTab?: string }[] = [];
  let active = "list";
  presentFlows(
    (_otui, _chrome, input) => {
      calls.push(input);
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    {},
    {},
    {
      items: [ITEM],
      onKeypress: (handler) => {
        handler({ name: "enter", sequence: "\r" });
        return () => {};
      },
    },
  );
  expect(calls[0]?.title).toBe("/flows");
  expect(calls[0]?.tabs.map((tab) => tab.id)).toEqual(["list", "detail", "ac"]);
  expect(active).toBe("detail");
  expect(formatFlowListText([ITEM])).toContain("154");
});

// Flow 328, AC7: per-criterion markers (met / not evident / not checkable /
// not run), a key ("c") to run the check, and `/ac` as a direct entry point.
test("isAcCommand accepts only /ac", () => {
  expect(isAcCommand("/ac")).toBe(true);
  expect(isAcCommand("  /ac 154")).toBe(true);
  expect(isAcCommand("/a")).toBe(false);
  expect(isAcCommand("/flows")).toBe(false);
});

test("formatAcMarkersSummary and formatAcCheckLines: not run vs. a cached result, English text", () => {
  expect(formatAcMarkersSummary(ITEM)).toBe("AC: not run");
  const notRunLines = formatAcCheckLines(ITEM).join("\n");
  expect(notRunLines).toContain("No acceptance-criteria check has been run");
  expect(notRunLines).toContain("c");

  const checked: FlowInspectorItem = {
    ...ITEM,
    acMarkers: [
      { id: "AC1", status: "likely-met", label: "likely met" },
      { id: "AC2", status: "not-evident", label: "not evident" },
      { id: "AC3", status: "not-checkable", label: "not checkable" },
    ],
    acCheckedAt: "2026-09-25T00:00:00.000Z",
  };
  expect(formatAcMarkersSummary(checked)).toBe("AC: 1 met, 1 not evident, 1 not checkable");
  const lines = formatAcCheckLines(checked);
  expect(lines.join("\n")).toContain("2026-09-25T00:00:00.000Z");
  expect(lines).toContain("AC1  [met]");
  expect(lines).toContain("AC2  [not evident]");
  expect(lines).toContain("AC3  [not checkable]");

  const stale: FlowInspectorItem = { ...checked, acCheckStale: true };
  expect(formatAcMarkersSummary(stale)).toContain("stale");
  expect(formatAcCheckLines(stale).join("\n")).toContain("STALE");
});

test("presentFlows: /ac requests the AC tab as initialTab, and `c` calls onRunCheck with the selected flow", async () => {
  let active = "list";
  let ran: FlowInspectorItem | undefined;
  const calls: { initialTab?: string }[] = [];
  presentFlows(
    (_otui, _chrome, input) => {
      calls.push(input);
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    {},
    {},
    {
      items: [ITEM],
      initialTab: "ac",
      onRunCheck: async (item) => {
        ran = item;
        return undefined;
      },
      onKeypress: (handler) => {
        handler({ name: "c", sequence: "c" });
        return () => {};
      },
    },
  );
  expect(calls[0]?.initialTab).toBe("ac");
  await Promise.resolve(); // let onRunCheck's own promise settle
  expect(ran?.id).toBe("154");
});

// Item 4 review finding: an in-modal busy state for `c`, `c` ignored while a
// check is in flight, and errors shown IN the modal rather than only on a
// terminal line the operator may already have scrolled past.
test("presentFlows: `c` shows 'Checking…', ignores a second `c` in flight, and shows the error in the AC tab on failure", async () => {
  let active = "ac";
  let acNode: { content: string } | undefined;
  let runCount = 0;
  let resolveCheck: ((outcome: { error?: string } | undefined) => void) | undefined;
  const checked: FlowInspectorItem = {
    ...ITEM,
    acMarkers: [{ id: "AC1", status: "likely-met", label: "likely met" }],
    acCheckedAt: "2026-09-25T00:00:00.000Z",
  };

  presentFlows(
    (_otui, _chrome, input) => {
      input.renderTab("ac", {
        add: (child: { content?: string }) => {
          acNode = child as { content: string };
        },
      });
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
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
    {
      items: [checked],
      initialTab: "ac",
      onRunCheck: () => {
        runCount += 1;
        return new Promise((resolve) => {
          resolveCheck = resolve;
        });
      },
      onKeypress: (handler) => {
        handler({ name: "c", sequence: "c" }); // starts the check
        handler({ name: "c", sequence: "c" }); // ignored — one is already in flight
        return () => {};
      },
    },
  );

  expect(runCount).toBe(1); // the second `c` never called onRunCheck again
  expect(acNode?.content).toContain("Checking…");

  resolveCheck?.({ error: "boom" });
  await Promise.resolve();
  await Promise.resolve();

  expect(acNode?.content).toContain("Error: boom");
});

test("windowLines and clampScroll keep a viewport over long bodies", () => {
  const lines = ["a", "b", "c", "d", "e"];
  expect(windowLines(lines, 0, 3)).toEqual(["a", "b", "c"]);
  expect(windowLines(lines, 3, 3)).toEqual(["c", "d", "e"]);
  expect(clampScroll(99, 5, 3)).toBe(2);
  expect(clampScroll(-1, 5, 3)).toBe(0);
});

test("on Detail, ↑/↓ scroll instead of changing the selected flow; [ ] switch", () => {
  const older: FlowInspectorItem = { ...ITEM, id: "001", title: "Older" };
  const newer: FlowInspectorItem = { ...ITEM, id: "154", title: "Newer" };
  let active = "detail";
  let node: { content: string } | undefined;
  presentFlows(
    (_otui, _chrome, input) => {
      input.renderTab("detail", {
        add: (child: { content?: string }) => {
          node = child as { content: string };
        },
      });
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    { TextRenderable: class {
      content: string;
      constructor(_r: unknown, opts: { content: string }) {
        this.content = opts.content;
      }
    } },
    {},
    {
      items: [older, newer],
      visibleRows: 20,
      onKeypress: (handler) => {
        expect(node?.content).toContain("Newer");
        handler({ name: "down", sequence: "down" });
        expect(node?.content).toContain("Newer");
        handler({ name: "]", sequence: "]" });
        expect(node?.content).toContain("Older");
        expect(node?.content).not.toContain("Newer");
        return () => {};
      },
    },
  );
});

import { expect, test } from "bun:test";
import type { FlowInspectorItem } from "./inspector-sources";
import {
  findFlowItem,
  formatFlowDetailLines,
  formatFlowListLines,
  formatFlowListText,
  isFlowsCommand,
  presentFlows,
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
  expect(calls[0]?.tabs.map((tab) => tab.id)).toEqual(["list", "detail"]);
  expect(active).toBe("detail");
  expect(formatFlowListText([ITEM])).toContain("154");
});

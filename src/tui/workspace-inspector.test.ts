import { expect, test } from "bun:test";
import type { SlateInspectorItem, WorkspaceInfo } from "./inspector-sources";
import {
  clampScroll,
  formatSlateDetailLines,
  formatSlateListLines,
  formatWorkspaceOverviewLines,
  isWorkspaceCommand,
  presentWorkspace,
  windowLines,
} from "./workspace-inspector";

const WORKSPACE: WorkspaceInfo = {
  id: "workspace-alpha",
  title: "Payments retry",
  status: "active",
  resources: [{ kind: "component", uri: "./src/payments" }],
};

// Newest-first by updatedAt: SLATE_B (Aug 17) sorts before SLATE_A (Aug 16).
const SLATE_A: SlateInspectorItem = {
  sessionId: "sess-aaaa1111",
  sessionTitle: "First pass",
  updatedAt: "2026-08-16T00:00:00.000Z",
  courseStatus: "active",
  flowRef: "042",
  seedCount: 1,
  touchedFiles: ["src/payments/retry.ts"],
  seeds: [{ id: "seed-1", text: "Retry backoff needs a cap", ts: "2026-08-16T00:00:00.000Z", kind: "decision" }],
};

const SLATE_B: SlateInspectorItem = {
  sessionId: "sess-bbbb2222",
  sessionTitle: "Follow-up",
  updatedAt: "2026-08-17T00:00:00.000Z",
  courseStatus: "blocked",
  seedCount: 0,
  touchedFiles: [],
  seeds: [],
};

test("isWorkspaceCommand accepts only /workspace", () => {
  expect(isWorkspaceCommand("/workspace")).toBe(true);
  expect(isWorkspaceCommand("  /workspace extra")).toBe(true);
  expect(isWorkspaceCommand("/workspaces")).toBe(false);
  expect(isWorkspaceCommand("/flows")).toBe(false);
});

test("overview lines include id, title, status, and slate count", () => {
  const lines = formatWorkspaceOverviewLines(WORKSPACE, 2).join("\n");
  expect(lines).toContain("workspace-alpha");
  expect(lines).toContain("Payments retry");
  expect(lines).toContain("active");
  expect(lines).toContain("Slates   2");
  expect(lines).toContain("./src/payments");
});

test("slate list highlights the selected row and shows flow/seed summary", () => {
  expect(formatSlateListLines([SLATE_A], 0)[0]?.startsWith("> ")).toBe(true);
  expect(formatSlateListLines([SLATE_A, SLATE_B], 1)[0]?.startsWith("  ")).toBe(true);
  const row = formatSlateListLines([SLATE_A], 0)[0] ?? "";
  expect(row).toContain("flow 042");
  expect(row).toContain("1 seeds");
  expect(formatSlateListLines([], 0)[0]).toMatch(/no slates/i);
});

test("slate detail lists touched files and seeds; absent slate says so", () => {
  const detail = formatSlateDetailLines(SLATE_A).join("\n");
  expect(detail).toContain("sess-aaaa1111");
  expect(detail).toContain("src/payments/retry.ts");
  expect(detail).toContain("Retry backoff needs a cap");
  expect(formatSlateDetailLines(undefined).join("\n")).toMatch(/no slate selected/i);
});

test("windowLines and clampScroll keep a viewport over long bodies", () => {
  const lines = ["a", "b", "c", "d", "e"];
  expect(windowLines(lines, 0, 3)).toEqual(["a", "b", "c"]);
  expect(windowLines(lines, 3, 3)).toEqual(["c", "d", "e"]);
  expect(clampScroll(99, 5, 3)).toBe(2);
  expect(clampScroll(-1, 5, 3)).toBe(0);
});

const FAKE_TEXT_RENDERABLE = {
  TextRenderable: class {
    content: string;
    constructor(_r: unknown, opts: { content: string }) {
      this.content = opts.content;
    }
  },
};

test("presentWorkspace opens Workspace/Slates/Detail, in that order", () => {
  const calls: { title: string; tabs: readonly { id: string }[] }[] = [];
  presentWorkspace(
    (_otui, _chrome, input) => {
      calls.push(input);
      let active = input.initialTab ?? input.tabs[0]?.id ?? "";
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    {},
    {},
    { workspace: WORKSPACE, slates: [SLATE_A, SLATE_B] },
  );
  expect(calls[0]?.title).toBe("/workspace");
  expect(calls[0]?.tabs.map((t) => t.id)).toEqual(["overview", "slates", "detail"]);
});

test("Enter on Slates jumps to Detail with the selected (newest-first) slate", () => {
  let active = "overview";
  let detailContent: string | undefined;
  let handle: { setTab: (id: string) => void; activeTab: () => string; close: () => void } | undefined;
  presentWorkspace(
    (_otui, _chrome, input) => {
      active = input.initialTab ?? "overview";
      const h = {
        close: () => input.onClose?.(),
        setTab: (id: string) => {
          active = id;
          const cleanup = input.renderTab(id, {
            add: (child: { content?: string }) => {
              if (id === "detail") detailContent = child.content;
            },
          });
          void cleanup;
        },
        activeTab: () => active,
      };
      handle = h;
      return h;
    },
    FAKE_TEXT_RENDERABLE,
    {},
    {
      workspace: WORKSPACE,
      slates: [SLATE_A, SLATE_B],
      visibleRows: 20,
      onKeypress: (handler) => {
        handle?.setTab("slates"); // real navigation, same as a user pressing →
        handler({ name: "]", sequence: "]" }); // move selection from SLATE_B (index 0) to SLATE_A (index 1)
        handler({ name: "enter", sequence: "\r" }); // opens the selected slate, jumps to Detail
        return () => {};
      },
    },
  );
  expect(active).toBe("detail");
  expect(detailContent).toContain(SLATE_A.sessionId);
});

test("leaving Detail back to Slates clears the open slate ('tab 3 closes')", () => {
  let active = "overview";
  let detailContent: string | undefined;
  let handle: { setTab: (id: string) => void; activeTab: () => string; close: () => void } | undefined;
  presentWorkspace(
    (_otui, _chrome, input) => {
      active = input.initialTab ?? "overview";
      let cleanup: (() => void) | undefined;
      const mount = (id: string): void => {
        cleanup = input.renderTab(id, {
          add: (child: { content?: string }) => {
            if (id === "detail") detailContent = child.content;
          },
        }) ?? undefined;
      };
      mount(active);
      const h = {
        close: () => input.onClose?.(),
        setTab: (id: string) => {
          if (id === active) return;
          cleanup?.(); // mirrors modal-host: unmount runs the outgoing tab's cleanup
          active = id;
          mount(id);
        },
        activeTab: () => active,
      };
      handle = h;
      return h;
    },
    FAKE_TEXT_RENDERABLE,
    {},
    {
      workspace: WORKSPACE,
      slates: [SLATE_A],
      visibleRows: 20,
      onKeypress: (handler) => {
        handle?.setTab("slates"); // real navigation, same as a user pressing →
        handler({ name: "enter", sequence: "\r" }); // opens SLATE_A, jumps to Detail
        return () => {};
      },
    },
  );
  expect(handle).toBeDefined();
  expect(handle?.activeTab()).toBe("detail");
  expect(detailContent).toContain(SLATE_A.sessionId);

  // Leave back to Slates, then return to Detail without a fresh Enter/click —
  // the previously-open slate must be gone ("tab 3 closes" on leaving it).
  handle?.setTab("slates");
  handle?.setTab("detail");
  expect(detailContent).toContain("No slate selected");
});

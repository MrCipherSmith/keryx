import { expect, test } from "bun:test";
import type { McpRuntimeStatus } from "../mcp/client-config";
import type { NormalizedToolDefinition } from "../harness/provider/types";
import { formatMcpListLines, formatToolsListLines, presentMcpTools } from "./mcp-inspector";

const TOOLS: readonly NormalizedToolDefinition[] = [
  { name: "gdgraph_affected", description: "blast radius", inputSchema: {}, risk: "read" },
  { name: "shell_exec", description: "run a command", inputSchema: {}, risk: "shell" },
];

const RUNTIMES: readonly McpRuntimeStatus[] = [
  { id: "cursor", filePath: "/proj/.cursor/mcp.json", connected: true },
  { id: "claude", filePath: "/proj/.mcp.json", connected: false },
  { id: "generic", filePath: null, connected: false },
];

test("formatToolsListLines renders name, risk, and description; empty says so", () => {
  const lines = formatToolsListLines(TOOLS);
  expect(lines[0]).toContain("gdgraph_affected");
  expect(lines[0]).toContain("read");
  expect(lines[0]).toContain("blast radius");
  expect(lines[1]).toContain("shell_exec");
  expect(lines[1]).toContain("shell");
  expect(formatToolsListLines([])).toEqual(["No tools available."]);
});

test("formatMcpListLines marks the selected row, shows status, and offers the opposite action", () => {
  const lines = formatMcpListLines(RUNTIMES, 0, { kind: "idle" });
  expect(lines[0]?.startsWith(">")).toBe(true);
  expect(lines[0]).toContain("Cursor");
  expect(lines[0]).toContain("● connected");
  expect(lines[0]).toContain("[d] disconnect");
  expect(lines[1]?.startsWith(" ")).toBe(true);
  expect(lines[1]).toContain("Claude Code");
  expect(lines[1]).toContain("○ not connected");
  expect(lines[1]).toContain("[c] connect");
});

test("formatMcpListLines never offers a connect/disconnect action for generic", () => {
  const lines = formatMcpListLines(RUNTIMES, 2, { kind: "idle" });
  expect(lines[2]).toContain("Generic (manual)");
  expect(lines[2]).not.toContain("[c]");
  expect(lines[2]).not.toContain("[d]");
  expect(lines[2]).toContain("copy snippet manually");
});

test("formatMcpListLines on an empty registry says so", () => {
  expect(formatMcpListLines([], 0, { kind: "idle" })).toEqual(["No MCP client runtimes registered."]);
});

test("presentMcpTools opens Tools+MCP tabs with the MCP footer", () => {
  const calls: { title: string; tabs: readonly { id: string }[]; footer?: readonly { key: string }[] }[] = [];
  let active = "tools";
  presentMcpTools(
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
      tools: TOOLS,
      runtimes: RUNTIMES,
      connect: async () => ({ ok: true }),
      disconnect: async () => ({ ok: true }),
    },
  );
  expect(calls[0]?.title).toBe("Tools & MCP");
  expect(calls[0]?.tabs.map((tab) => tab.id)).toEqual(["tools", "mcp"]);
  expect(calls[0]?.footer?.some((action) => action.key === "c/d")).toBe(true);
  expect(calls[0]?.footer?.some((action) => action.key === "click")).toBe(true);
});

/** Fake `TextRenderable`: one instance per row, each carrying its own `onMouseDown` — mirrors `background-job-inspector.test.ts`'s `FakeText`. */
type FakeRow = { id: string; content: string; onMouseDown: (() => void) | undefined };
function fakeOtui(): { TextRenderable: new (r: unknown, opts: { id: string; content: string; onMouseDown?: () => void }) => FakeRow } {
  return {
    TextRenderable: class implements FakeRow {
      id: string;
      content: string;
      onMouseDown: (() => void) | undefined;
      constructor(_r: unknown, opts: { id: string; content: string; onMouseDown?: () => void }) {
        this.id = opts.id;
        this.content = opts.content;
        this.onMouseDown = opts.onMouseDown;
      }
    },
  };
}

/** A live per-tab body: `add`/`getChildren`/`remove` back a plain array, exactly what `clearTranscriptChildren` (and a real OpenTUI `Box`) expects — so a repaint that clears-then-rebuilds rows behaves the same as it would against a real renderer. */
function fakeBody(): { add: (c: unknown) => void; getChildren: () => readonly unknown[]; remove: (c: unknown) => void; rows: () => FakeRow[] } {
  const children: unknown[] = [];
  return {
    add: (c) => children.push(c),
    getChildren: () => children,
    remove: (c) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
    },
    rows: () => children as FakeRow[],
  };
}

function findRow(rows: FakeRow[], id: string): FakeRow | undefined {
  return rows.find((r) => r.id === id);
}

test("Tools tab renders one clickable-free row per tool, in order", () => {
  let active = "tools";
  const body = fakeBody();
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("tools", body);
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    fakeOtui(),
    {},
    { tools: TOOLS, runtimes: RUNTIMES, visibleRows: 20, connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }) },
  );
  const rows = body.rows();
  expect(rows).toHaveLength(2);
  expect(rows[0]?.content).toContain("gdgraph_affected");
  expect(rows[0]?.onMouseDown).toBeUndefined();
  expect(rows[1]?.content).toContain("shell_exec");
});

test("MCP tab renders one clickable row per runtime, marking the selection", () => {
  let active = "mcp";
  const body = fakeBody();
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", body);
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    fakeOtui(),
    {},
    { tools: TOOLS, runtimes: RUNTIMES, visibleRows: 20, connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }) },
  );
  const rows = body.rows();
  expect(rows).toHaveLength(3);
  expect(findRow(rows, "mcp-row-cursor")?.content).toContain(">");
  expect(findRow(rows, "mcp-row-cursor")?.content).toContain("[d] disconnect");
  expect(findRow(rows, "mcp-row-cursor")?.onMouseDown).toBeTypeOf("function");
  expect(findRow(rows, "mcp-row-claude")?.content).toContain("[c] connect");
  expect(findRow(rows, "mcp-row-generic")?.content).toContain("copy snippet manually");
  expect(findRow(rows, "mcp-row-generic")?.onMouseDown).toBeTypeOf("function");
});

test("clicking a disconnected row's line arms connect; clicking the same row again confirms and connects", async () => {
  let active = "mcp";
  const body = fakeBody();
  let connectedId: string | undefined;
  let changed: readonly McpRuntimeStatus[] | undefined;
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", body);
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    fakeOtui(),
    {},
    {
      tools: TOOLS,
      runtimes: RUNTIMES,
      visibleRows: 20,
      connect: async (id) => {
        connectedId = id;
        return { ok: true };
      },
      disconnect: async () => ({ ok: true }),
      onStatusChange: (r) => {
        changed = r;
      },
    },
  );

  findRow(body.rows(), "mcp-row-claude")?.onMouseDown?.();
  expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("press y to connect");
  expect(connectedId).toBeUndefined();

  findRow(body.rows(), "mcp-row-claude")?.onMouseDown?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(connectedId).toBe("claude");
  expect(changed?.find((r) => r.id === "claude")?.connected).toBe(true);
  expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("✓ done");
});

test("clicking a different actionable row while one is armed re-arms the new row instead of confirming the old one", () => {
  let active = "mcp";
  const body = fakeBody();
  const connectCalls: string[] = [];
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", body);
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    fakeOtui(),
    {},
    {
      tools: TOOLS,
      runtimes: RUNTIMES,
      visibleRows: 20,
      connect: async (id) => {
        connectCalls.push(id);
        return { ok: true };
      },
      disconnect: async (id) => {
        connectCalls.push(id);
        return { ok: true };
      },
    },
  );

  findRow(body.rows(), "mcp-row-claude")?.onMouseDown?.(); // arms connect on claude
  expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("press y to connect");

  findRow(body.rows(), "mcp-row-cursor")?.onMouseDown?.(); // clicks a DIFFERENT row instead
  expect(findRow(body.rows(), "mcp-row-cursor")?.content).toContain("press y to disconnect");
  expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("[c] connect"); // claude's arm was cancelled
  expect(connectCalls).toEqual([]); // neither action actually ran yet — only armed
});

test("clicking the generic row only selects it — it never arms, since there is no file to connect/disconnect", () => {
  let active = "mcp";
  const body = fakeBody();
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", body);
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    fakeOtui(),
    {},
    { tools: TOOLS, runtimes: RUNTIMES, visibleRows: 20, connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }) },
  );
  findRow(body.rows(), "mcp-row-generic")?.onMouseDown?.();
  const generic = findRow(body.rows(), "mcp-row-generic");
  expect(generic?.content).toContain(">");
  expect(generic?.content).toContain("copy snippet manually");
  expect(generic?.content).not.toContain("press y");
});

test("[c] arms connect on the MCP tab for a disconnected runtime; any non-y key cancels", () => {
  let active = "mcp";
  const body = fakeBody();
  let connectCalls = 0;
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", body);
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    fakeOtui(),
    {},
    {
      tools: TOOLS,
      runtimes: RUNTIMES,
      visibleRows: 20,
      connect: async () => {
        connectCalls += 1;
        return { ok: true };
      },
      disconnect: async () => ({ ok: true }),
      onKeypress: (handler) => {
        // Move to the disconnected "claude" row (index 1) first.
        handler({ name: "down", sequence: "" });
        handler({ name: "c", sequence: "c" });
        expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("press y to connect");
        handler({ name: "x", sequence: "x" });
        expect(findRow(body.rows(), "mcp-row-claude")?.content).not.toContain("press y to connect");
        expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("[c] connect");
        expect(connectCalls).toBe(0);
        return () => {};
      },
    },
  );
});

test("[c] then [y] connects, flips the row's status locally, and fires onStatusChange", async () => {
  let active = "mcp";
  const body = fakeBody();
  let changed: readonly McpRuntimeStatus[] | undefined;
  let resolveConnect: (() => void) | undefined;
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", body);
      return { close: () => input.onClose?.(), setTab: (id) => { active = id; }, activeTab: () => active };
    },
    fakeOtui(),
    {},
    {
      tools: TOOLS,
      runtimes: RUNTIMES,
      visibleRows: 20,
      connect: (id) =>
        new Promise((resolve) => {
          resolveConnect = () => resolve({ ok: true });
          expect(id).toBe("claude");
        }),
      disconnect: async () => ({ ok: true }),
      onStatusChange: (runtimes) => {
        changed = runtimes;
      },
      onKeypress: (handler) => {
        handler({ name: "down", sequence: "" });
        handler({ name: "c", sequence: "c" });
        handler({ name: "y", sequence: "y" });
        expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("connecting…");
        return () => {};
      },
    },
  );
  expect(resolveConnect).toBeDefined();
  resolveConnect?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(changed?.find((r) => r.id === "claude")?.connected).toBe(true);
  expect(findRow(body.rows(), "mcp-row-claude")?.content).toContain("✓ done");
});

test("[d] never arms for generic (no file to disconnect)", () => {
  let active = "mcp";
  const body = fakeBody();
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", body);
      return { close: () => {}, setTab: () => {}, activeTab: () => active };
    },
    fakeOtui(),
    {},
    {
      tools: TOOLS,
      runtimes: RUNTIMES,
      visibleRows: 20,
      connect: async () => ({ ok: true }),
      disconnect: async () => ({ ok: true }),
      onKeypress: (handler) => {
        handler({ name: "down", sequence: "" });
        handler({ name: "down", sequence: "" });
        handler({ name: "d", sequence: "d" });
        expect(findRow(body.rows(), "mcp-row-generic")?.content).not.toContain("press y to disconnect");
        return () => {};
      },
    },
  );
});

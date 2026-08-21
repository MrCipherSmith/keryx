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
});

function fakeOtui(): { TextRenderable: new (r: unknown, opts: { content: string }) => { content: string } } {
  return {
    TextRenderable: class {
      content: string;
      constructor(_r: unknown, opts: { content: string }) {
        this.content = opts.content;
      }
    },
  };
}

test("[c] arms connect on the MCP tab for a disconnected runtime; any non-y key cancels", () => {
  let active = "mcp";
  let node: { content: string } | undefined;
  let connectCalls = 0;
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", {
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
        expect(node?.content).toContain("press y to connect");
        handler({ name: "x", sequence: "x" });
        expect(node?.content).not.toContain("press y to connect");
        expect(node?.content).toContain("[c] connect");
        expect(connectCalls).toBe(0);
        return () => {};
      },
    },
  );
});

test("[c] then [y] connects, flips the row's status locally, and fires onStatusChange", async () => {
  let active = "mcp";
  let node: { content: string } | undefined;
  let changed: readonly McpRuntimeStatus[] | undefined;
  let resolveConnect: (() => void) | undefined;
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", {
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
        expect(node?.content).toContain("connecting…");
        return () => {};
      },
    },
  );
  expect(resolveConnect).toBeDefined();
  resolveConnect?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(changed?.find((r) => r.id === "claude")?.connected).toBe(true);
  expect(node?.content).toContain("✓ done");
});

test("[d] never arms for generic (no file to disconnect)", () => {
  let active = "mcp";
  let node: { content: string } | undefined;
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("mcp", {
        add: (child: { content?: string }) => {
          node = child as { content: string };
        },
      });
      return {
        close: () => input.onClose?.(),
        setTab: () => {},
        activeTab: () => active,
      };
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
        expect(node?.content).not.toContain("press y to disconnect");
        return () => {};
      },
    },
  );
});

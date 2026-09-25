import { describe, expect, test } from "bun:test";
import type { McpRuntimeStatus } from "../mcp/client-config";
import type { NormalizedToolDefinition } from "../harness/provider/types";
import {
  approvalLabel,
  fitRowsByLines,
  formatMcpListLines,
  formatToolRowLines,
  formatToolsListLines,
  isMcpToolsCommand,
  MCP_INSPECTOR_FOOTER,
  MCP_TAB_KEYS,
  presentMcpTools,
  TOOLS_COLUMN_HEADER,
  wrapHangingRow,
} from "./mcp-inspector";

const TOOLS: readonly NormalizedToolDefinition[] = [
  { name: "gdgraph_affected", description: "blast radius", inputSchema: {}, risk: "read" },
  { name: "shell_exec", description: "run a command", inputSchema: {}, risk: "shell" },
];

const RUNTIMES: readonly McpRuntimeStatus[] = [
  { id: "cursor", filePath: "/proj/.cursor/mcp.json", connected: true, otherServers: ["context7", "playwright"] },
  { id: "claude", filePath: "/proj/.mcp.json", connected: false, otherServers: [] },
  { id: "generic", filePath: null, connected: false, otherServers: [] },
];

test("formatToolsListLines renders name, approval, and description; empty says so", () => {
  const lines = formatToolsListLines(TOOLS);
  expect(lines[0]).toContain("gdgraph_affected");
  expect(lines[0]).toContain("none");
  expect(lines[0]).toContain("blast radius");
  expect(lines[1]).toContain("shell_exec");
  expect(lines[1]).toContain("shell");
  expect(formatToolsListLines([])).toEqual(["No tools available."]);
});

describe("AC5 — /tools rows wrap with a hanging indent under the description column", () => {
  const LONG: NormalizedToolDefinition = {
    name: "shell_task_kill",
    description:
      "Stop a background task this session started. Only tasks owned by the current session can be stopped; others are refused.",
    inputSchema: {},
    risk: "read",
  };
  // `tool` (28) + space + `approval` (8) + space.
  const DESCRIPTION_COLUMN = 38;

  test("at width 80 every line fits, and every continuation starts at the description column", () => {
    const lines = formatToolRowLines(LONG, 80);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines[0]?.startsWith("shell_task_kill ")).toBe(true);
    expect(lines[0]?.slice(DESCRIPTION_COLUMN).startsWith("Stop a background")).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.slice(0, DESCRIPTION_COLUMN)).toBe(" ".repeat(DESCRIPTION_COLUMN));
      expect(line[DESCRIPTION_COLUMN]).not.toBe(" ");
    }
    // Nothing lost or reordered by the wrap.
    expect(lines.map((line) => line.slice(DESCRIPTION_COLUMN)).join(" ")).toBe(LONG.description ?? "");
  });

  test("exact layout at width 80", () => {
    expect(formatToolRowLines(LONG, 80)).toEqual([
      "shell_task_kill              none     Stop a background task this session",
      "                                      started. Only tasks owned by the current",
      "                                      session can be stopped; others are",
      "                                      refused.",
    ]);
  });

  test("a name longer than its column still hangs continuations under the description column", () => {
    const lines = formatToolRowLines({ ...LONG, name: "an_extremely_long_tool_name_beyond_28" }, 80);
    expect(lines[1]?.slice(0, DESCRIPTION_COLUMN)).toBe(" ".repeat(DESCRIPTION_COLUMN));
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  test("a panel too narrow for the column falls back to a shallow indent instead of a one-word column", () => {
    const lines = formatToolRowLines(LONG, 50);
    for (const line of lines.slice(1)) expect(line.startsWith("    ") && line[4] !== " ").toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
  });

  test("the list joins a wrapped tool's lines into one entry, one per tool", () => {
    const entries = formatToolsListLines([LONG, ...TOOLS], 80);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.split("\n")).toEqual(formatToolRowLines(LONG, 80));
  });

  test("no width means no wrap — the single line a caller without a measured panel always got", () => {
    expect(formatToolRowLines(LONG)).toHaveLength(1);
  });
});

describe("AC5 — the hanging wrap helper", () => {
  test("keeps the multi-space gaps between words that fit", () => {
    expect(wrapHangingRow("> x ", "● on  [d] disconnect", 80)).toEqual(["> x ● on  [d] disconnect"]);
  });

  test("a path with a space stays one unit and breaks only before a slash", () => {
    const lines = wrapHangingRow(
      "head ",
      "run ~/Library/Application Support/Cursor/extensions/some-server/dist/index.js",
      40,
      5,
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    // The line that caught the link detector: a continuation opening on `Support/…`.
    for (const line of lines.slice(1)) expect(line.trimStart().startsWith("Support/")).toBe(false);
    for (const line of lines.slice(1)) expect(/^ {5}[/~]/.test(line)).toBe(true);
  });
});

describe("AC5 — /integrate MCP client rows wrap the same way", () => {
  test("at width 60 the tail hangs under the status column and no line overflows", () => {
    const lines = formatMcpListLines(RUNTIMES, 0, { kind: "idle" }, 60)[0]?.split("\n") ?? [];
    expect(lines.length).toBeGreaterThan(1);
    // `> ` + label (20) + space.
    for (const line of lines.slice(1)) expect(line.slice(0, 23)).toBe(" ".repeat(23));
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    expect(lines.join(" ")).toContain("context7, playwright");
  });
});

describe("AC7 — the risk column is labelled as the approval it causes", () => {
  test("read means no approval; anything else names the risk that asks", () => {
    expect(approvalLabel("read")).toBe("none");
    expect(approvalLabel(undefined)).toBe("none");
    expect(approvalLabel("shell")).toBe("shell");
    expect(approvalLabel("write")).toBe("write");
  });

  test("shell_task_kill and shell_task_wait read as 'no approval needed', under an 'approval' header", () => {
    expect(TOOLS_COLUMN_HEADER).toMatch(/^tool\s+approval\s+description$/);
    const approvalAt = TOOLS_COLUMN_HEADER.indexOf("approval");
    for (const name of ["shell_task_kill", "shell_task_wait"]) {
      const [line] = formatToolRowLines({ name, description: "x", inputSchema: {}, risk: "read" }, 80);
      expect(line?.slice(approvalAt, approvalAt + 8).trim()).toBe("none");
      expect(line).not.toContain("read");
    }
  });
});

describe("AC6 — footer keys act on every tab; tab-only keys live on their tab", () => {
  test("the shared footer promises nothing the Tools tab cannot do", () => {
    const keys = MCP_INSPECTOR_FOOTER.map((action) => action.key);
    expect(keys).toEqual(["↑/↓", "←/→", "esc"]);
    expect(MCP_INSPECTOR_FOOTER.map((action) => action.label).join(" ")).not.toMatch(/connect|confirm/);
  });

  test("connect/disconnect/confirm hints appear on the MCP tab and not on the Tools tab", () => {
    expect(MCP_TAB_KEYS).toContain("c/d connect/disconnect");
    expect(MCP_TAB_KEYS).toContain("y confirm");
    const renderTabs = (tabId: string): string => {
      const body = fakeBody();
      presentMcpTools(
        (_otui, _chrome, input) => {
          input.renderTab(tabId, body, { width: 100 });
          return { close: () => {}, setTab: () => {}, activeTab: () => tabId };
        },
        fakeOtui(),
        {},
        { tools: TOOLS, runtimes: RUNTIMES, visibleRows: 20, connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }) },
      );
      return body.rows().map((row) => row.content).join("\n");
    };
    expect(renderTabs("mcp")).toContain(MCP_TAB_KEYS);
    expect(renderTabs("tools")).not.toContain("connect/disconnect");
    expect(renderTabs("tools")).not.toContain("confirm");
  });
});

test("formatMcpListLines marks the selected row, shows status, and offers the opposite action", () => {
  const lines = formatMcpListLines(RUNTIMES, 0, { kind: "idle" });
  expect(lines[0]?.startsWith(">")).toBe(true);
  expect(lines[0]).toContain("Cursor");
  expect(lines[0]).toContain("● keryx connected");
  expect(lines[0]).toContain("[d] disconnect");
  expect(lines[1]?.startsWith(" ")).toBe(true);
  expect(lines[1]).toContain("Claude Code");
  expect(lines[1]).toContain("○ keryx not connected");
  expect(lines[1]).toContain("[c] connect");
});

test("formatMcpListLines surfaces the OTHER MCP servers a client already has configured, capped and never for keryx itself", () => {
  const lines = formatMcpListLines(RUNTIMES, 0, { kind: "idle" });
  expect(lines[0]).toContain("also has: context7, playwright");
  expect(lines[1]).not.toContain("also has:"); // claude has none configured
  const manyServers = formatMcpListLines(
    [{ id: "cursor", filePath: "/p/.cursor/mcp.json", connected: false, otherServers: ["a", "b", "c", "d", "e", "f"] }],
    0,
    { kind: "idle" },
  );
  expect(manyServers[0]).toContain("also has: a, b, c, d, +2 more");
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

test("presentMcpTools opens Tools+MCP tabs with the tab-agnostic footer", () => {
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
  // AC6: `c/d`/`y` act only on the MCP tab, so they are that tab's first
  // body line, not a footer promise shown on Tools too.
  expect(calls[0]?.footer).toEqual(MCP_INSPECTOR_FOOTER);
  expect(calls[0]?.footer?.some((action) => action.key === "c/d")).toBe(false);
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

test("Tools tab opens with an explanatory caption, then one clickable-free row per tool, in order", () => {
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
  expect(rows).toHaveLength(4); // caption + column header + 2 tools
  expect(findRow(rows, "mcp-tools-columns")?.content).toBe(TOOLS_COLUMN_HEADER);
  const caption = String(findRow(rows, "mcp-tools-header")?.content ?? "");
  expect(caption).toContain("Built into keryx");
  // Spec AC17, closed in P2. The caption originally ended "…keryx doesn't
  // consume MCP servers as a client yet", which P0 made false. P0 pointed
  // it at the CLI because the consumer view did not exist — a caption
  // naming a missing screen is the failure the rename avoided. P2 built
  // the view, so the caption names the view.
  // `toContain("/mcp")` matched any superstring, so repointing the
  // caption at `/mcps` — the one command this codebase forbids
  // everywhere else — survived. Assert the exact token.
  expect(caption).toMatch(/`\/mcp`/);
  expect(caption).not.toContain("/mcps");
  expect(caption).not.toContain("doesn't consume");
  expect(caption).not.toContain("does not consume");
  expect(rows[2]?.content).toContain("gdgraph_affected");
  expect(rows[2]?.onMouseDown).toBeUndefined();
  expect(rows[3]?.content).toContain("shell_exec");
});

test("MCP tab opens with a two-line caption, then one clickable row per runtime, marking the selection", () => {
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
  expect(rows).toHaveLength(6); // 2 caption lines + key hints + 3 runtimes
  expect(findRow(rows, "mcp-mcp-keys")?.content).toBe(MCP_TAB_KEYS);
  expect(findRow(rows, "mcp-mcp-header-1")?.content).toContain("ONLY keryx's own MCP server");
  expect(findRow(rows, "mcp-mcp-header-2")?.content).toContain("read-only");
  expect(findRow(rows, "mcp-row-cursor")?.content).toContain(">");
  expect(findRow(rows, "mcp-row-cursor")?.content).toContain("[d] disconnect");
  expect(findRow(rows, "mcp-row-cursor")?.content).toContain("also has: context7, playwright");
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
  const active = "mcp";
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

test("/integrate opens this view and /mcp no longer does", () => {
  // CHANGED IN P2, deliberately. This asserted that `/mcp` still opened
  // the installer, on the grounds that "the rename must not make a
  // command vanish under someone mid-session" — a real concern, and the
  // right call while the consumer view did not exist.
  //
  // P2 built it, so `/mcp` does not vanish: it now means what D-04 says
  // it means, the servers keryx CONNECTS TO. That is a better answer to
  // the original concern than pointing it at the installer forever,
  // because the installer is the surface this file's own header warns is
  // "easy to misread as 'the MCP servers this agent is connected to'".
  expect(isMcpToolsCommand("/integrate")).toBe(true);
  expect(isMcpToolsCommand("/mcp")).toBe(false);

  // And `/mcps` is still nobody's command — it would differ from `/mcp` by one
  // character while meaning the opposite, with no flags to say which ran.
  expect(isMcpToolsCommand("/mcps")).toBe(false);
});

// --- flow 270 review F-003: paging by screen lines, not by item count ------

describe("fitRowsByLines — wrapped rows page by the lines they take", () => {
  test("fills the window from start and clamps start so the last window is full", () => {
    expect(fitRowsByLines([2, 2, 2, 2], 0, 4)).toEqual({ start: 0, end: 2 });
    expect(fitRowsByLines([2, 2, 2, 2], 3, 5)).toEqual({ start: 2, end: 4 });
    expect(fitRowsByLines([1, 1, 1], 99, 10)).toEqual({ start: 0, end: 3 });
  });

  test("an item taller than the window is still shown on its own", () => {
    expect(fitRowsByLines([7, 1], 0, 3)).toEqual({ start: 0, end: 1 });
    expect(fitRowsByLines([], 4, 3)).toEqual({ start: 0, end: 0 });
  });

  // Seen on 0.2.118: get_cwd (2), list_dir (3), read_file (11) left 8 of 24
  // rows blank because search_code (9) did not fit whole.
  test("the rows left under the last whole item go to the start of the next one", () => {
    expect(fitRowsByLines([2, 3, 11, 9, 4], 0, 24)).toEqual({ start: 0, end: 4, lastLines: 8 });
    expect(fitRowsByLines([2, 2, 2, 2], 0, 5)).toEqual({ start: 0, end: 3, lastLines: 1 });
  });
});

test("the Tools tab fills its rows: no blank space under the list while more tools follow", () => {
  const tall: NormalizedToolDefinition[] = Array.from({ length: 6 }, (_, i) => ({
    name: `tool_${i}`,
    description: "word ".repeat(40 + i * 7).trim(),
    inputSchema: { type: "object" },
    risk: "read",
  }));
  const body = fakeBody();
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("tools", body, { width: 100 });
      return { close: () => input.onClose?.(), setTab: () => {}, activeTab: () => "tools" };
    },
    fakeOtui(),
    {},
    { tools: tall, runtimes: RUNTIMES, visibleRows: 20, connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }) },
  );
  const lines = body.rows().map((row) => row.content).join("\n").split("\n");
  expect(lines).toHaveLength(20); // caption + column header + tools, exactly the body
});

test("the last of many wrapped tools is reachable with the down arrow", () => {
  const many: NormalizedToolDefinition[] = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_number_${i}`,
    description: "a long description ".repeat(10).trim(),
    inputSchema: { type: "object" },
    risk: "read",
  }));
  const body = fakeBody();
  let press: ((key: { name: string; sequence: string }) => void) | undefined;
  presentMcpTools(
    (_otui, _chrome, input) => {
      input.renderTab("tools", body, { width: 100 });
      return { close: () => input.onClose?.(), setTab: () => {}, activeTab: () => "tools" };
    },
    fakeOtui(),
    {},
    {
      tools: many,
      runtimes: RUNTIMES,
      visibleRows: 20,
      connect: async () => ({ ok: true }),
      disconnect: async () => ({ ok: true }),
      onKeypress: (handler) => {
        press = handler;
        return () => {};
      },
    },
  );
  for (let i = 0; i < 60; i++) press?.({ name: "down", sequence: "" });
  const shown = body.rows().map((row) => row.content).join("\n");
  expect(shown).toContain("tool_number_39");
  // And the window holds no more lines than the body has rows.
  expect(shown.split("\n").length).toBeLessThanOrEqual(20);
});

// Seen on 0.2.119: ModalHost gives every tab ONE body container. After a
// visit to MCP Clients, the first ↓ back on Tools repainted both tabs into
// it and the MCP rows replaced the tool list under a strip reading [Tools].
test("after visiting MCP Clients, ↓ on the Tools tab keeps showing tools", () => {
  const body = fakeBody();
  let active = "tools";
  let press: ((key: { name: string; sequence: string }) => void) | undefined;
  let host: { renderTab: (id: string, b: unknown, c?: { width: number }) => unknown } | undefined;
  presentMcpTools(
    (_otui, _chrome, input) => {
      host = input;
      input.renderTab("tools", body, { width: 100 });
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
      connect: async () => ({ ok: true }),
      disconnect: async () => ({ ok: true }),
      onKeypress: (handler) => {
        press = handler;
        return () => {};
      },
    },
  );
  // Switch to MCP Clients and back, the way ModalHost re-mounts a tab: the
  // same body, cleared and handed to renderTab again.
  const remount = (id: string): void => {
    for (const child of [...body.getChildren()]) body.remove(child);
    active = id;
    host?.renderTab(id, body, { width: 100 });
  };
  remount("mcp");
  remount("tools");
  press?.({ name: "down", sequence: "" });

  const shown = body.rows().map((row) => row.content).join("\n");
  expect(shown).toContain("gdgraph_affected");
  expect(shown).not.toContain("keryx connected"); // every MCP client row says (not) connected
  expect(shown).not.toContain("keryx not connected");
});

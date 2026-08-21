// Tools/MCP inspector modal: a "Tools" tab listing the tools this agent has
// access to, and an "MCP" tab listing every registered MCP client runtime
// (cursor, claude, opencode, vscode, generic) with its live connect status and
// a clickable connect/disconnect action per row.
//
// Rows are real per-row `TextRenderable`s with their own `onMouseDown`, not
// one text blob — the same `onMouseDown`-per-row idiom `background-job-
// inspector.ts`'s sidebar and Kill button already use (that file's header
// comment calls it out explicitly as the reusable pattern for a clickable
// list row in this modal-host family). A single joined-string node can only
// ever be keyboard-driven — OpenTUI mouse events target a whole Renderable,
// not a substring inside one — so per-row buttons are a hard requirement,
// not a style choice.
//
// Clicking a row is a two-step confirm exactly like the keyboard path: first
// click arms the action (same as pressing `c`/`d` after selecting the row),
// second click on the same row confirms (same as pressing `y`). Keyboard nav
// is untouched — arrows still move the selection, `c`/`d` still arm, `y`
// still confirms; the click just gives the same state machine a mouse entry
// point that doesn't require first knowing the keyboard sequence.
//
// Deliberately keeps "LLM providers" (OpenAI-compat chat endpoints, configured
// via `/search-provider`) and "MCP" (keryx's own outbound `mcp serve` server,
// installed into an editor's client config) as two separate concepts: this
// modal is MCP only. An LLM provider picker is a different surface.

import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { clampScroll, scrollToReveal } from "./review-inspector";
import { clearTranscriptChildren } from "./transcript-blocks";
import type { McpRuntimeStatus } from "../mcp/client-config";
import type { NormalizedToolDefinition } from "../harness/provider/types";

export const MCP_INSPECTOR_FOOTER = [
  { key: "↑/↓", label: "select" },
  { key: "click", label: "row: select/act" },
  { key: "c/d", label: "connect/disconnect" },
  { key: "y", label: "confirm" },
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

export const MCP_TOOLS_COMMAND = "/mcp";

export function isMcpToolsCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === MCP_TOOLS_COMMAND;
}

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

/**
 * Static, non-interactive caption mounted above each tab's rows — review
 * finding: the Tools tab (this agent's own callable tools) and the MCP tab
 * (client configs keryx's own server can be installed into) look similar
 * enough to a first-time viewer that neither read as self-explanatory
 * without one. The MCP tab in particular is easy to misread as "the MCP
 * servers this agent is connected to" (context7, playwright, …) — it is
 * the opposite: it is where KERYX ITSELF gets installed as one more MCP
 * server into an editor's config, alongside whatever else that editor
 * already has configured (surfaced per row via `otherServers`).
 */
const TOOLS_TAB_HEADER =
  "Built into keryx — not from an external MCP server (keryx doesn't consume MCP servers as a client yet).";
const MCP_TAB_HEADER_1 = "Connects/disconnects ONLY keryx's own MCP server, one editor config at a time.";
const MCP_TAB_HEADER_2 = "Other MCP servers already configured there (context7, playwright, …) show per row, read-only.";

/** Display label for a runtime id; falls back to the id itself for one this module does not know about. */
export const RUNTIME_LABELS: Record<string, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  opencode: "opencode",
  vscode: "VS Code",
  generic: "Generic (manual)",
};

function runtimeLabel(id: string): string {
  return RUNTIME_LABELS[id] ?? id;
}

function formatToolRowLine(tool: NormalizedToolDefinition): string {
  const risk = (tool.risk ?? "read").padEnd(6);
  const name = tool.name.padEnd(28);
  return `${name} ${risk} ${tool.description ?? ""}`.trimEnd();
}

export function formatToolsListLines(tools: readonly NormalizedToolDefinition[]): string[] {
  if (tools.length === 0) {
    return ["No tools available."];
  }
  return tools.map(formatToolRowLine);
}

export type McpArmedAction = { id: string; action: "connect" | "disconnect" };
export type McpActionStatus =
  | { kind: "idle" }
  | { kind: "armed"; target: McpArmedAction }
  | { kind: "running"; target: McpArmedAction }
  | { kind: "done"; target: McpArmedAction; outcome: { ok: true } | { ok: false; message: string } };

/** `generic` writes no file — there is nothing to connect/disconnect, only a snippet to copy. */
function isActionable(id: string): boolean {
  return id !== "generic";
}

/** Rows only ever show a handful of names inline — a client with a long `mcpServers` list gets a "+N more" tail instead of an unbounded line. */
const MAX_OTHER_SERVERS_SHOWN = 4;

/** The OTHER MCP servers (context7, playwright, …) this client already has configured — read-only context, never this modal's own connect/disconnect target. Empty for `generic` (no file) or a client with no other servers. */
function formatOtherServers(otherServers: readonly string[]): string {
  if (otherServers.length === 0) {
    return "";
  }
  const shown = otherServers.slice(0, MAX_OTHER_SERVERS_SHOWN);
  const rest = otherServers.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", ");
  return `  · also has: ${list}`;
}

function formatMcpRowLine(runtime: McpRuntimeStatus, isSelected: boolean, status: McpActionStatus): string {
  const mark = isSelected ? ">" : " ";
  const label = runtimeLabel(runtime.id).padEnd(20);
  const statusText = runtime.connected ? "● keryx connected" : "○ keryx not connected";
  let action = "";
  if (!isActionable(runtime.id)) {
    action = "  (copy snippet manually)";
  } else if (status.kind === "armed" && status.target.id === runtime.id) {
    action = `  [click again or press y to ${status.target.action}]`;
  } else if (status.kind === "running" && status.target.id === runtime.id) {
    action = `  ${status.target.action === "connect" ? "connecting…" : "disconnecting…"}`;
  } else if (status.kind === "done" && status.target.id === runtime.id) {
    action = status.outcome.ok ? "  ✓ done" : `  ✗ ${status.outcome.message}`;
  } else {
    action = runtime.connected ? "  [d] disconnect" : "  [c] connect";
  }
  return `${mark} ${label} ${statusText}${action}${formatOtherServers(runtime.otherServers)}`;
}

export function formatMcpListLines(
  runtimes: readonly McpRuntimeStatus[],
  selected: number,
  status: McpActionStatus,
): string[] {
  if (runtimes.length === 0) {
    return ["No MCP client runtimes registered."];
  }
  return runtimes.map((runtime, index) => formatMcpRowLine(runtime, index === selected, status));
}

export type ConnectOutcome = { ok: true } | { ok: false; message: string };
export type ConnectFn = (id: string) => Promise<ConnectOutcome>;

export type PresentMcpToolsOptions = {
  tools: readonly NormalizedToolDefinition[];
  runtimes: readonly McpRuntimeStatus[];
  connect: ConnectFn;
  disconnect: ConnectFn;
  /** Fires after a connect/disconnect attempt settles (success or failure) — the caller's cue to refresh a sidebar badge. */
  onStatusChange?: (runtimes: readonly McpRuntimeStatus[]) => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

type RowNode = { content: string };
type RowTextCtor = new (
  renderer: unknown,
  opts: { id: string; content: string; onMouseDown?: () => void },
) => RowNode;
type RowTarget = {
  add: (child: unknown) => void;
  getChildren: () => readonly unknown[];
  remove: (child: unknown) => void;
};

function asRowTarget(body: unknown): RowTarget | undefined {
  const parent = body as {
    add?: (child: unknown) => void;
    getChildren?: () => readonly unknown[];
    remove?: (child: unknown) => void;
  };
  if (parent.add === undefined || parent.getChildren === undefined || parent.remove === undefined) {
    return undefined;
  }
  return {
    add: parent.add.bind(parent),
    getChildren: parent.getChildren.bind(parent),
    remove: parent.remove.bind(parent),
  };
}

export function presentMcpTools(
  openModal: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentMcpToolsOptions,
): ModalHandle | undefined {
  const runtimes = options.runtimes.map((r) => ({ ...r }));
  let mcpSelected = 0;
  let toolsScroll = 0;
  let mcpScroll = 0;
  let status: McpActionStatus = { kind: "idle" };
  let toolsBody: RowTarget | undefined;
  let mcpBody: RowTarget | undefined;
  let rowCtor: RowTextCtor | undefined;
  let activeRenderer: unknown;
  let unsubscribeKey: (() => void) | undefined;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);

  const paintToolsRows = (): void => {
    if (toolsBody === undefined || rowCtor === undefined) {
      return;
    }
    clearTranscriptChildren(toolsBody);
    toolsBody.add(new rowCtor(activeRenderer, { id: "mcp-tools-header", content: TOOLS_TAB_HEADER }));
    if (options.tools.length === 0) {
      toolsBody.add(new rowCtor(activeRenderer, { id: "mcp-tools-empty", content: "No tools available." }));
      return;
    }
    const start = clampScroll(toolsScroll, options.tools.length, bodyRows);
    for (const [i, tool] of options.tools.slice(start, start + bodyRows).entries()) {
      toolsBody.add(new rowCtor(activeRenderer, { id: `mcp-tool-row-${start + i}`, content: formatToolRowLine(tool) }));
    }
  };

  const paintMcpRows = (): void => {
    if (mcpBody === undefined || rowCtor === undefined) {
      return;
    }
    clearTranscriptChildren(mcpBody);
    mcpBody.add(new rowCtor(activeRenderer, { id: "mcp-mcp-header-1", content: MCP_TAB_HEADER_1 }));
    mcpBody.add(new rowCtor(activeRenderer, { id: "mcp-mcp-header-2", content: MCP_TAB_HEADER_2 }));
    if (runtimes.length === 0) {
      mcpBody.add(new rowCtor(activeRenderer, { id: "mcp-mcp-empty", content: "No MCP client runtimes registered." }));
      return;
    }
    const start = clampScroll(mcpScroll, runtimes.length, bodyRows);
    for (const [i, runtime] of runtimes.slice(start, start + bodyRows).entries()) {
      const index = start + i;
      mcpBody.add(
        new rowCtor(activeRenderer, {
          id: `mcp-row-${runtime.id}`,
          content: formatMcpRowLine(runtime, index === mcpSelected, status),
          onMouseDown: () => handleRowClick(runtime.id, index),
        }),
      );
    }
  };

  const paint = (): void => {
    toolsScroll = clampScroll(toolsScroll, options.tools.length, bodyRows);
    mcpScroll = scrollToReveal(mcpSelected, mcpScroll, bodyRows);
    mcpScroll = clampScroll(mcpScroll, runtimes.length, bodyRows);
    paintToolsRows();
    paintMcpRows();
  };

  const moveMcpSelection = (next: number): void => {
    if (runtimes.length === 0) {
      return;
    }
    const clamped = Math.min(runtimes.length - 1, Math.max(0, next));
    if (clamped === mcpSelected) {
      return;
    }
    mcpSelected = clamped;
    status = { kind: "idle" };
    paint();
  };

  const runAction = (): void => {
    if (status.kind !== "armed") {
      return;
    }
    const target = status.target;
    status = { kind: "running", target };
    paint();
    const fn = target.action === "connect" ? options.connect : options.disconnect;
    void fn(target.id).then((outcome) => {
      status = { kind: "done", target, outcome };
      if (outcome.ok) {
        const row = runtimes.find((r) => r.id === target.id);
        if (row !== undefined) {
          row.connected = target.action === "connect";
        }
      }
      options.onStatusChange?.(runtimes);
      paint();
    });
  };

  /** Arms the given row's action (connect if disconnected, disconnect if connected) — the keyboard `c`/`d` and a first row click both funnel through here. */
  const armFor = (id: string): void => {
    const index = runtimes.findIndex((r) => r.id === id);
    const row = runtimes[index];
    if (index < 0 || row === undefined || !isActionable(row.id) || status.kind === "running") {
      return;
    }
    mcpSelected = index;
    status = { kind: "armed", target: { id: row.id, action: row.connected ? "disconnect" : "connect" } };
    paint();
  };

  /** First click on a row arms its action; a second click on the SAME armed row confirms — the mouse mirrors the keyboard's [c/d]-then-[y] gate exactly. */
  const handleRowClick = (id: string, index: number): void => {
    if (status.kind === "armed" && status.target.id === id) {
      runAction();
      return;
    }
    if (status.kind === "running") {
      return;
    }
    if (!isActionable(id)) {
      if (index !== mcpSelected) {
        mcpSelected = index;
        status = { kind: "idle" };
        paint();
      }
      return;
    }
    armFor(id);
  };

  const handle = openModal(otui, chrome, {
    title: "Tools & MCP",
    tabs: [
      { id: "tools", label: "Tools" },
      { id: "mcp", label: "MCP Clients" },
    ],
    initialTab: "tools",
    footer: MCP_INSPECTOR_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const ctor = (otui as { TextRenderable?: RowTextCtor }).TextRenderable;
      const target = asRowTarget(body);
      if (target === undefined || ctor === undefined) {
        return;
      }
      rowCtor = ctor;
      activeRenderer = renderer;
      if (tabId === "tools") {
        toolsBody = target;
        toolsScroll = clampScroll(toolsScroll, options.tools.length, bodyRows);
        paintToolsRows();
        return;
      }
      mcpBody = target;
      mcpScroll = scrollToReveal(mcpSelected, mcpScroll, bodyRows);
      paintMcpRows();
      // Rows are fixed-width columns already; `ctx?.width` wrapping would
      // break mid-status-text, so it is deliberately unused here.
      void ctx;
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      const onMcp = handle.activeTab() === "mcp";

      // Armed confirm consumes the very next key unconditionally — only an
      // exact `y` confirms; everything else (including nav keys) cancels back
      // to idle rather than falling through to navigation. Mirrors
      // review-inspector's [a]-then-[y] accept gate exactly.
      if (onMcp && status.kind === "armed") {
        if (token === "y") {
          runAction();
        } else {
          status = { kind: "idle" };
          paint();
        }
        return;
      }
      if (onMcp && token === "c") {
        const row = runtimes[mcpSelected];
        if (row !== undefined && isActionable(row.id) && !row.connected && status.kind !== "running") {
          status = { kind: "armed", target: { id: row.id, action: "connect" } };
          paint();
        }
        return;
      }
      if (onMcp && token === "d") {
        const row = runtimes[mcpSelected];
        if (row !== undefined && isActionable(row.id) && row.connected && status.kind !== "running") {
          status = { kind: "armed", target: { id: row.id, action: "disconnect" } };
          paint();
        }
        return;
      }
      if (token === "up" || token === "k") {
        if (onMcp) {
          moveMcpSelection(mcpSelected - 1);
        } else {
          toolsScroll = clampScroll(toolsScroll - 1, options.tools.length, bodyRows);
          paint();
        }
        return;
      }
      if (token === "down" || token === "j") {
        if (onMcp) {
          moveMcpSelection(mcpSelected + 1);
        } else {
          toolsScroll = clampScroll(toolsScroll + 1, options.tools.length, bodyRows);
          paint();
        }
        return;
      }
      if (token === "pageup" || token === "pagedown") {
        const step = token === "pageup" ? -bodyRows : bodyRows;
        if (onMcp) {
          mcpScroll = clampScroll(mcpScroll + step, runtimes.length, bodyRows);
        } else {
          toolsScroll = clampScroll(toolsScroll + step, options.tools.length, bodyRows);
        }
        paint();
      }
    });
  }
  return handle;
}

export function openMcpTools(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentMcpToolsOptions,
): ModalHandle | undefined {
  return presentMcpTools(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

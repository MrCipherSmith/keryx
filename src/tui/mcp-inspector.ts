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

/**
 * Only keys that act on EVERY tab (flow 270 AC6). ModalHost paints one
 * footer per modal, not per tab, and this footer used to promise
 * `c/d connect/disconnect · y confirm` on the Tools tab, where both keys
 * do nothing. The MCP tab's own keys are its first body line instead
 * (`MCP_TAB_KEYS`), which is the only place they are true.
 */
export const MCP_INSPECTOR_FOOTER = [
  { key: "↑/↓", label: "scroll/select" },
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

export const MCP_TAB_KEYS = "keys: c/d connect/disconnect · y confirm · click a row to arm, again to confirm";

export const MCP_TOOLS_COMMAND = "/integrations";

/**
 * `/mcp` is NO LONGER this view.
 *
 * It opened the installer before the rename and kept doing so through P0
 * and P1, with a comment saying why: "It is deliberately NOT repointed at
 * the MCP-server consumer: that surface does not exist yet, and a slash
 * command aimed at nothing is worse than one aimed at the old thing."
 *
 * P2 built that surface, so `/mcp` now means what D-04 says it means —
 * the servers keryx CONNECTS TO (`mcp-consumer.ts`). This view keeps
 * `/integrations`, which is what it always was: where keryx ITSELF is
 * registered into an editor's config.
 *
 * The two are genuinely easy to confuse — this file's own header says the
 * MCP tab "is easy to misread as 'the MCP servers this agent is connected
 * to'". They are now two commands with two captions, which is the only
 * version of that distinction a user can act on.
 */
export function isMcpToolsCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === MCP_TOOLS_COMMAND;
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
// Spec AC17. The original wording ended "…keryx doesn't consume MCP servers
// as a client yet", which became false the moment `search_tool`/`use_tool`
// reached the shell's tool list in P0. It was then pointed at the CLI,
// because the consumer view did not exist and a caption naming a missing
// screen is the failure the rename avoided in the first place. P2 built the
// view, so it names the view.
const TOOLS_TAB_HEADER =
  "Built into keryx — not from an external MCP server. For those, see `/mcp` (or `keryx mcp list`).";
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

/** Below this many columns, hanging under the description column reads worse than a shallow indent. */
const MIN_HANGING_BUDGET = 24;
const FALLBACK_INDENT = 4;

/**
 * Break a word too long for any line. At the last `/` inside the budget,
 * and BEFORE it, so the continuation starts `/Cursor/…` — read as a path
 * — rather than `Cursor/…`, which a terminal's link detector took for a
 * host (`http://Support/…` in the operator's screenshot).
 */
function splitLongWord(word: string, budget: number): string[] {
  const pieces: string[] = [];
  let rest = word;
  while (rest.length > budget) {
    const slash = rest.lastIndexOf("/", budget);
    const cut = slash > 0 ? slash : budget;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/**
 * One row as lines no wider than `width`, continuation lines hanging
 * under column `indent` (flow 270 AC5).
 *
 * The rows used to be one string that the terminal wrapped at column 0,
 * so a tool's description ran back under the NAME column and the table
 * stopped being a table. Word-wrapped on spaces, keeping the run of
 * spaces between words that fit (the `  [d] disconnect` gaps are layout).
 * A narrow panel falls back to a shallow indent rather than a
 * one-word-wide column. `width` undefined means "do not wrap" — a caller
 * with no measured panel gets the old single line, not a guessed width.
 */
export function wrapHangingRow(head: string, text: string, width?: number, indent: number = head.length): string[] {
  if (width === undefined) {
    return [`${head}${text}`.trimEnd()];
  }
  const hang = width - indent >= MIN_HANGING_BUDGET ? indent : Math.min(indent, FALLBACK_INDENT);
  const pad = " ".repeat(hang);
  const budget = Math.max(1, width - hang);
  const out: string[] = [];
  let current = head;
  let fresh = true;
  // A path with a space in it (`~/Library/Application Support/Cursor/…`)
  // is one unit, not two words: wrapping at that space started a line
  // with `Support/Cursor/…`, the exact text the link detector grabbed.
  // Glued, it can only break before a `/`.
  const units: { word: string; gap: string }[] = [];
  for (const match of text.matchAll(/(\S+)( *)/g)) {
    const word = match[1] as string;
    const last = units.at(-1);
    if (last !== undefined && last.gap === " " && last.word.includes("/") && word.includes("/") && !/^[/~-]/.test(word)) {
      last.word += ` ${word}`;
      last.gap = match[2] as string;
      continue;
    }
    units.push({ word, gap: match[2] as string });
  }
  let gap = "";
  for (const unit of units) {
    for (const [i, piece] of splitLongWord(unit.word, budget).entries()) {
      const sep = fresh || i > 0 ? "" : gap;
      if (current.length + sep.length + piece.length <= width || (fresh && current === pad)) {
        current += sep + piece;
      } else {
        out.push(current.trimEnd());
        current = pad + piece;
      }
      fresh = false;
    }
    gap = unit.gap;
  }
  out.push(current.trimEnd());
  return out;
}

const TOOL_NAME_COLUMN = 28;
const TOOL_APPROVAL_COLUMN = 8;

/**
 * The column is what the risk DOES here — decide whether a call is asked
 * about (flow 270 AC7). Printed raw, `read` beside `shell_task_kill`
 * read as a claim that killing a task is a read; it is `read` because it
 * only touches this session's own tasks, so it needs no approval. `none`
 * says that; any other risk is named, since it is the one that asks.
 */
export function approvalLabel(risk: string | undefined): string {
  const value = risk ?? "read";
  return value === "read" ? "none" : value;
}

export const TOOLS_COLUMN_HEADER = `${"tool".padEnd(TOOL_NAME_COLUMN)} ${"approval".padEnd(TOOL_APPROVAL_COLUMN)} description`;

export function formatToolRowLines(tool: NormalizedToolDefinition, width?: number): string[] {
  const head = `${tool.name.padEnd(TOOL_NAME_COLUMN)} ${approvalLabel(tool.risk).padEnd(TOOL_APPROVAL_COLUMN)} `;
  // Hang under the description COLUMN, not under the end of this head: a
  // name longer than the column pushes its own first line, not the table.
  return wrapHangingRow(head, tool.description ?? "", width, TOOL_NAME_COLUMN + TOOL_APPROVAL_COLUMN + 2);
}

/**
 * The window of wrapped rows that fits `rows` screen lines, starting at item
 * `start` (flow 270): items wrap to several lines, so paging by item count
 * left the last tools unreachable. `start` is clamped so the final window is
 * full; at least one item is always shown, even one taller than `rows`.
 */
export function fitRowsByLines(
  lineCounts: readonly number[],
  start: number,
  rows: number,
): { start: number; end: number } {
  if (lineCounts.length === 0) {
    return { start: 0, end: 0 };
  }
  // The furthest start whose tail still fills the window.
  let maxStart = lineCounts.length - 1;
  let tail = lineCounts[maxStart] ?? 1;
  while (maxStart > 0 && tail + (lineCounts[maxStart - 1] ?? 1) <= rows) {
    maxStart -= 1;
    tail += lineCounts[maxStart] ?? 1;
  }
  const from = Math.min(maxStart, Math.max(0, start));
  let end = from + 1;
  let used = lineCounts[from] ?? 1;
  while (end < lineCounts.length && used + (lineCounts[end] ?? 1) <= rows) {
    used += lineCounts[end] ?? 1;
    end += 1;
  }
  return { start: from, end };
}

/** One entry per tool; a wrapped tool's lines are joined with `\n`, since each tool is one renderable. */
export function formatToolsListLines(tools: readonly NormalizedToolDefinition[], width?: number): string[] {
  if (tools.length === 0) {
    return ["No tools available."];
  }
  return tools.map((tool) => formatToolRowLines(tool, width).join("\n"));
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

function formatMcpRowLine(runtime: McpRuntimeStatus, isSelected: boolean, status: McpActionStatus, width?: number): string {
  const mark = isSelected ? ">" : " ";
  const label = runtimeLabel(runtime.id).padEnd(20);
  const statusText = runtime.connected ? "● keryx connected" : "○ keryx not connected";
  let action: string;
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
  return wrapHangingRow(`${mark} ${label} `, `${statusText}${action}${formatOtherServers(runtime.otherServers)}`, width).join(
    "\n",
  );
}

export function formatMcpListLines(
  runtimes: readonly McpRuntimeStatus[],
  selected: number,
  status: McpActionStatus,
  width?: number,
): string[] {
  if (runtimes.length === 0) {
    return ["No MCP client runtimes registered."];
  }
  return runtimes.map((runtime, index) => formatMcpRowLine(runtime, index === selected, status, width));
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
  /** The panel's inner width from ModalHost's render context; undefined until a tab is mounted with one. */
  let bodyWidth: number | undefined;
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
    toolsBody.add(new rowCtor(activeRenderer, { id: "mcp-tools-columns", content: TOOLS_COLUMN_HEADER }));
    const rows = options.tools.map((tool) => formatToolRowLines(tool, bodyWidth));
    const window = toolsWindow(rows);
    toolsScroll = window.start;
    for (let index = window.start; index < window.end; index++) {
      toolsBody.add(
        new rowCtor(activeRenderer, {
          id: `mcp-tool-row-${index}`,
          content: (rows[index] ?? []).join("\n"),
        }),
      );
    }
  };

  /** Rows left for tools under the caption (which may wrap) and the column header. */
  const toolsRowBudget = (): number => {
    const captionLines = wrapHangingRow("", TOOLS_TAB_HEADER, bodyWidth, 0).length;
    return Math.max(1, bodyRows - captionLines - 1);
  };
  // `toolsScroll` is the first tool shown; painting clamps it to the window
  // that fits, so the key handlers below only move it.
  const toolsWindow = (rows: readonly string[][]): { start: number; end: number } =>
    fitRowsByLines(rows.map((lines) => lines.length), toolsScroll, toolsRowBudget());

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
    mcpBody.add(new rowCtor(activeRenderer, { id: "mcp-mcp-keys", content: MCP_TAB_KEYS }));
    const start = clampScroll(mcpScroll, runtimes.length, bodyRows);
    for (const [i, runtime] of runtimes.slice(start, start + bodyRows).entries()) {
      const index = start + i;
      mcpBody.add(
        new rowCtor(activeRenderer, {
          id: `mcp-row-${runtime.id}`,
          content: formatMcpRowLine(runtime, index === mcpSelected, status, bodyWidth),
          onMouseDown: () => handleRowClick(runtime.id, index),
        }),
      );
    }
  };

  const paint = (): void => {
    toolsScroll = Math.max(0, toolsScroll);
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
      bodyWidth = ctx?.width;
      if (tabId === "tools") {
        toolsBody = target;
        toolsScroll = Math.max(0, toolsScroll);
        paintToolsRows();
        return;
      }
      mcpBody = target;
      mcpScroll = scrollToReveal(mcpSelected, mcpScroll, bodyRows);
      paintMcpRows();
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
          toolsScroll = Math.max(0, toolsScroll - 1);
          paint();
        }
        return;
      }
      if (token === "down" || token === "j") {
        if (onMcp) {
          moveMcpSelection(mcpSelected + 1);
        } else {
          toolsScroll += 1;
          paint();
        }
        return;
      }
      if (token === "pageup" || token === "pagedown") {
        const step = token === "pageup" ? -bodyRows : bodyRows;
        if (onMcp) {
          mcpScroll = clampScroll(mcpScroll + step, runtimes.length, bodyRows);
        } else {
          toolsScroll = Math.max(0, toolsScroll + step);
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

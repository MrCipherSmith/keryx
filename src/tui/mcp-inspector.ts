// Tools/MCP inspector modal: a "Tools" tab listing the tools this agent has
// access to, and an "MCP" tab listing every registered MCP client runtime
// (cursor, claude, opencode, vscode, generic) with its live connect status and
// a two-key confirm connect/disconnect action. Mirrors review-inspector.ts's
// list+detail interaction model (openModal host, injectable openModal/keypress
// for pure testing, [key]-then-[y] confirm for the one mutating action).
//
// Deliberately keeps "LLM providers" (OpenAI-compat chat endpoints, configured
// via `/search-provider`) and "MCP" (keryx's own outbound `mcp serve` server,
// installed into an editor's client config) as two separate concepts: this
// modal is MCP only. An LLM provider picker is a different surface.

import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { clampScroll, scrollToReveal, windowLines } from "./review-inspector";
import type { McpRuntimeStatus } from "../mcp/client-config";
import type { NormalizedToolDefinition } from "../harness/provider/types";

export const MCP_INSPECTOR_FOOTER = [
  { key: "↑/↓", label: "select" },
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

export function formatToolsListLines(tools: readonly NormalizedToolDefinition[]): string[] {
  if (tools.length === 0) {
    return ["No tools available."];
  }
  return tools.map((tool) => {
    const risk = (tool.risk ?? "read").padEnd(6);
    const name = tool.name.padEnd(28);
    return `${name} ${risk} ${tool.description ?? ""}`.trimEnd();
  });
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

export function formatMcpListLines(
  runtimes: readonly McpRuntimeStatus[],
  selected: number,
  status: McpActionStatus,
): string[] {
  if (runtimes.length === 0) {
    return ["No MCP client runtimes registered."];
  }
  return runtimes.map((runtime, index) => {
    const mark = index === selected ? ">" : " ";
    const label = runtimeLabel(runtime.id).padEnd(20);
    const statusText = runtime.connected ? "● connected" : "○ not connected";
    let action = "";
    if (!isActionable(runtime.id)) {
      action = "  (copy snippet manually)";
    } else if (status.kind === "armed" && status.target.id === runtime.id) {
      action = `  [press y to ${status.target.action}]`;
    } else if (status.kind === "running" && status.target.id === runtime.id) {
      action = `  ${status.target.action === "connect" ? "connecting…" : "disconnecting…"}`;
    } else if (status.kind === "done" && status.target.id === runtime.id) {
      action = status.outcome.ok ? "  ✓ done" : `  ✗ ${status.outcome.message}`;
    } else {
      action = runtime.connected ? "  [d] disconnect" : "  [c] connect";
    }
    return `${mark} ${label} ${statusText}${action}`;
  });
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
  let toolsNode: { content: string } | undefined;
  let mcpNode: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);

  const toolLines = (): string[] => formatToolsListLines(options.tools);
  const mcpLines = (): string[] => formatMcpListLines(runtimes, mcpSelected, status);

  const paint = (): void => {
    toolsScroll = clampScroll(toolsScroll, toolLines().length, bodyRows);
    mcpScroll = scrollToReveal(mcpSelected, mcpScroll, bodyRows);
    mcpScroll = clampScroll(mcpScroll, mcpLines().length, bodyRows);
    if (toolsNode !== undefined) {
      toolsNode.content = windowLines(toolLines(), toolsScroll, bodyRows).join("\n");
    }
    if (mcpNode !== undefined) {
      mcpNode.content = windowLines(mcpLines(), mcpScroll, bodyRows).join("\n");
    }
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

  const handle = openModal(otui, chrome, {
    title: "Tools & MCP",
    tabs: [
      { id: "tools", label: "Tools" },
      { id: "mcp", label: "MCP" },
    ],
    initialTab: "tools",
    footer: MCP_INSPECTOR_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const parent = body as { add?: (child: unknown) => void };
      const ctor = (
        otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } }
      ).TextRenderable;
      if (parent.add === undefined || ctor === undefined) {
        return;
      }
      if (tabId === "tools") {
        toolsScroll = clampScroll(toolsScroll, toolLines().length, bodyRows);
        toolsNode = new ctor(renderer, { id: "mcp-tools-body", content: windowLines(toolLines(), toolsScroll, bodyRows).join("\n") });
        parent.add(toolsNode);
        return;
      }
      mcpScroll = scrollToReveal(mcpSelected, mcpScroll, bodyRows);
      mcpNode = new ctor(renderer, { id: "mcp-mcp-body", content: windowLines(mcpLines(), mcpScroll, bodyRows).join("\n") });
      parent.add(mcpNode);
      // Passing `ctx?.width` through would wrap rows mid-status-text; rows here
      // are already fixed-width columns, so no width-based wrapping is applied.
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
          toolsScroll = clampScroll(toolsScroll - 1, toolLines().length, bodyRows);
          paint();
        }
        return;
      }
      if (token === "down" || token === "j") {
        if (onMcp) {
          moveMcpSelection(mcpSelected + 1);
        } else {
          toolsScroll = clampScroll(toolsScroll + 1, toolLines().length, bodyRows);
          paint();
        }
        return;
      }
      if (token === "pageup" || token === "pagedown") {
        const step = token === "pageup" ? -bodyRows : bodyRows;
        if (onMcp) {
          mcpScroll = clampScroll(mcpScroll + step, mcpLines().length, bodyRows);
        } else {
          toolsScroll = clampScroll(toolsScroll + step, toolLines().length, bodyRows);
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

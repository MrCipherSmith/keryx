// Session-info inspector (flow 155): pure snapshot + text dump + host presenter.
// TUI open goes through `openModal` from `./modal-host`. No private overlay.

import type { NormalizedUsage } from "../harness/provider/types";
import { buildContextUsage, formatContextUsageText, type ContextUsageView } from "./context-usage";
import {
  flowsInSession,
  formatSessionFlowLines,
  formatWorkspaceLines,
  workspacesInSession,
  type FlowInspectorItem,
  type WorkspaceInfo,
} from "./inspector-sources";
import { openModal } from "./modal-host";

export const SESSION_INFO_COMMANDS = ["/status"] as const;

const MISSING = "—";

export type SessionInfoRow = {
  label: string;
  value: string;
};

export type SessionInfoSnapshot = {
  sessionId: string;
  sessionRows: SessionInfoRow[];
  usageRows: SessionInfoRow[];
  context: ContextUsageView;
  workspaceLines: string[];
  flowLines: string[];
  hasWorkspaces: boolean;
  hasFlows: boolean;
};

export type SessionInfoSource = {
  summary?: {
    id?: string;
    title?: string;
    projectPath?: string;
    createdAt?: string;
    updatedAt?: string;
    messageCount?: number;
    archiveMessageCount?: number;
    compactCount?: number;
    provider?: string;
    model?: string;
    parentSessionId?: string;
  } | undefined;
  selection?: { provider?: string; model?: string } | undefined;
  version?: string | undefined;
  usage?: Pick<NormalizedUsage, "inputTokens" | "outputTokens" | "totalTokens"> | undefined;
  estimateTokens?: number | undefined;
  sessionText?: string | undefined;
  workspaces?: readonly WorkspaceInfo[] | undefined;
  flows?: readonly FlowInspectorItem[] | undefined;
};

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  onClose?: () => void;
};

/** One-line hints; keep `formatModalFooter(...)` within the wrap budget. */
export const SESSION_INFO_FOOTER = [
  { key: "c", label: "copy id" },
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type OpenModalFn = (
  otui: unknown,
  chrome: unknown,
  input: OpenModalInput,
) => ModalHandle | undefined;

export function isSessionInfoCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return (SESSION_INFO_COMMANDS as readonly string[]).includes(token);
}

function displayOrMissing(value: string | undefined): string {
  return value !== undefined && value.length > 0 ? value : MISSING;
}

function formatUtc(iso: string | undefined): string {
  if (iso === undefined || iso.length === 0) {
    return MISSING;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return MISSING;
  }
  return `${date.toISOString()} UTC`;
}

function formatCount(value: number | undefined): string {
  return value === undefined ? MISSING : String(value);
}

function usageUsed(usage: SessionInfoSource["usage"]): number | undefined {
  if (usage === undefined) {
    return undefined;
  }
  if (usage.totalTokens !== undefined) {
    return usage.totalTokens;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function contextRow(source: SessionInfoSource): string {
  const used = usageUsed(source.usage);
  if (used !== undefined) {
    return `${used} tokens`;
  }
  if (source.estimateTokens !== undefined) {
    return `${source.estimateTokens} tokens (estimate)`;
  }
  return MISSING;
}

export function buildSessionInfoSnapshot(source: SessionInfoSource): SessionInfoSnapshot {
  const id = source.summary?.id ?? "";
  const provider = source.selection?.provider ?? source.summary?.provider;
  const model = source.selection?.model ?? source.summary?.model;
  const sessionRows: SessionInfoRow[] = [
    { label: "Title", value: displayOrMissing(source.summary?.title) },
    { label: "Version", value: displayOrMissing(source.version) },
    { label: "Session id", value: displayOrMissing(source.summary?.id) },
    { label: "Project", value: displayOrMissing(source.summary?.projectPath) },
    { label: "Provider", value: displayOrMissing(provider) },
    { label: "Model", value: displayOrMissing(model) },
  ];
  if (source.summary?.parentSessionId !== undefined && source.summary.parentSessionId.length > 0) {
    sessionRows.push({ label: "Parent", value: source.summary.parentSessionId });
  }
  const messages =
    source.summary?.messageCount === undefined && source.summary?.archiveMessageCount === undefined
      ? MISSING
      : `${formatCount(source.summary.messageCount)} / ${formatCount(source.summary.archiveMessageCount)}`;
  sessionRows.push(
    { label: "Created", value: formatUtc(source.summary?.createdAt) },
    { label: "Updated", value: formatUtc(source.summary?.updatedAt) },
    { label: "Messages", value: messages },
    { label: "Compactions", value: formatCount(source.summary?.compactCount) },
    { label: "Context", value: contextRow(source) },
  );

  const estimate =
    source.estimateTokens === undefined ? MISSING : `${source.estimateTokens} tokens (estimate)`;
  const usageRows: SessionInfoRow[] = [
    {
      label: "Last turn input",
      value: source.usage?.inputTokens === undefined ? MISSING : String(source.usage.inputTokens),
    },
    {
      label: "Last turn output",
      value: source.usage?.outputTokens === undefined ? MISSING : String(source.usage.outputTokens),
    },
    { label: "Context estimate", value: estimate },
  ];
  const context = buildContextUsage({
    estimateTokens: source.estimateTokens,
    usage: source.usage,
  });
  const sessionWorkspaces = workspacesInSession(source.workspaces ?? [], {
    sessionId: id,
    ...(source.sessionText !== undefined ? { sessionText: source.sessionText } : {}),
  });
  const sessionFlows = flowsInSession(source.flows ?? [], {
    sessionId: id,
    ...(source.sessionText !== undefined ? { sessionText: source.sessionText } : {}),
  });

  return {
    sessionId: id,
    sessionRows,
    usageRows,
    context,
    workspaceLines: formatWorkspaceLines(sessionWorkspaces),
    flowLines: formatSessionFlowLines(sessionFlows),
    hasWorkspaces: sessionWorkspaces.length > 0,
    hasFlows: sessionFlows.length > 0,
  };
}

function formatSection(title: string, rows: readonly SessionInfoRow[]): string {
  const width = rows.reduce((max, row) => Math.max(max, row.label.length), 0);
  return [title, ...rows.map((row) => `  ${row.label.padEnd(width)}  ${row.value}`)].join("\n");
}

export function formatSessionInfoText(snapshot: SessionInfoSnapshot): string {
  const extra: string[] = [];
  extra.push(formatContextUsageText(snapshot.context));
  if (snapshot.hasWorkspaces) {
    extra.push(["Workspaces", ...snapshot.workspaceLines.map((line) => `  ${line}`), ""].join("\n"));
  }
  if (snapshot.hasFlows) {
    extra.push(["Flow", ...snapshot.flowLines.map((line) => `  ${line}`), ""].join("\n"));
  }
  return `${formatSection("Session", snapshot.sessionRows)}\n\n${formatSection("Usage", snapshot.usageRows)}\n\n${extra.join("\n")}`;
}

export function sessionIdCopyText(snapshot: SessionInfoSnapshot): string {
  return snapshot.sessionId;
}

export function sessionBlockCopyText(snapshot: SessionInfoSnapshot): string {
  return formatSessionInfoText(snapshot);
}

export function statusModalTabs(snapshot: SessionInfoSnapshot): { id: string; label: string }[] {
  const tabs = [
    { id: "status", label: "Status" },
    { id: "context", label: "Context" },
  ];
  if (snapshot.hasWorkspaces) {
    tabs.push({ id: "workspaces", label: "Workspaces" });
  }
  if (snapshot.hasFlows) {
    tabs.push({ id: "flow", label: "Flow" });
  }
  return tabs;
}

export type PresentSessionInfoOptions = {
  snapshot: SessionInfoSnapshot;
  copyText: (text: string) => void;
  toast: (message: string) => void;
  renderer?: { copyToClipboardOSC52?: (text: string) => void };
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

function wrapBlock(text: string, width: number): string {
  if (width < 8) {
    return text;
  }
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) {
        return [line];
      }
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += width) {
        chunks.push(line.slice(i, i + width));
      }
      return chunks;
    })
    .join("\n");
}

function paintContent(otui: unknown, renderer: unknown, body: unknown, content: string, width?: number): void {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return;
  }
  const parent = body as { add?: (child: unknown) => void };
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => unknown })
    .TextRenderable;
  if (parent.add === undefined || ctor === undefined) {
    return;
  }
  const next = width !== undefined ? wrapBlock(content, width) : content;
  parent.add(new ctor(renderer, { id: "session-info-body", content: next }));
}

function paintRows(
  otui: unknown,
  renderer: unknown,
  body: unknown,
  rows: readonly SessionInfoRow[],
  wrapWidth?: number,
): void {
  const width = rows.reduce((max, row) => Math.max(max, row.label.length), 0);
  paintContent(
    otui,
    renderer,
    body,
    rows.map((row) => `${row.label.padEnd(width)}  ${row.value}`).join("\n"),
    wrapWidth,
  );
}

export function presentSessionInfo(
  openModal: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentSessionInfoOptions,
): ModalHandle | undefined {
  const { snapshot, toast } = options;
  const copy = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    try {
      options.copyText(text);
      toast("Copied to clipboard");
    } catch {
      // clipboard access not permitted
    }
  };
  let unsubscribeKey: (() => void) | undefined;
  const handle = openModal(otui, chrome, {
    title: "/status",
    tabs: statusModalTabs(snapshot),
    initialTab: "status",
    footer: SESSION_INFO_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer =
        options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const width = ctx?.width;
      if (tabId === "context") {
        paintContent(otui, renderer, body, formatContextUsageText(snapshot.context).trimEnd(), width);
        return;
      }
      if (tabId === "workspaces") {
        paintContent(otui, renderer, body, snapshot.workspaceLines.join("\n"), width);
        return;
      }
      if (tabId === "flow") {
        paintContent(otui, renderer, body, snapshot.flowLines.join("\n"), width);
        return;
      }
      paintRows(otui, renderer, body, snapshot.sessionRows, width);
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
      if (token === "c") {
        copy(sessionIdCopyText(snapshot));
      }
    });
  }
  return handle;
}

/** Open the shared host on Status + Context. No-op when OpenTUI/chrome is missing. */
export function openSessionInfo(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentSessionInfoOptions,
): ModalHandle | undefined {
  return presentSessionInfo(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

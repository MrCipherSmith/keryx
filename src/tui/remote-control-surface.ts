// `/remote-control`: the TUI and readline halves of the shell's remote control
// (flow 376, AC3/AC12). The sidebar row, the modal, the slash command's text
// and the readline text are all built from one `RemoteStatus`, so no surface
// states something the others do not.
//
// Remote control is OFF unless this command turned it on. Nothing here starts
// it: `presentRemoteControl` and the panel only ask the host to (`onToggle`,
// `onOpen`), and the host runs the same code the typed command runs.

import { REMOTE_EVENT_LIMIT, type RemoteEvent, type RemoteState, type RemoteStatus, TG_SOURCE } from "../remote/shell-bridge";
import { clampScroll, wrapLines, windowLines, type ModalHandle, type OpenModalFn } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { onThemeChange, type TextRole } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const REMOTE_CONTROL_COMMAND = "/remote-control";
export const REMOTE_CONTROL_SUMMARY = "Mirror this session into a Telegram topic: /remote-control [name|off|status]";

/** The label a line from Telegram carries in the transcript echo and the queue. */
export const TG_LABEL = TG_SOURCE;
/** The echo marker for a Telegram line (the user's own lines keep `❯`). */
export const TG_ECHO_MARKER = `${TG_LABEL} ❯`;

/** `[tg] text`, for the queue panel and any plain-text listing. */
/** The transcript line for a typed slash command: `❯ /model`, or `tg ❯ /model` when it came from the topic. */
export function commandEchoText(line: string, source?: string): string {
  return source === TG_SOURCE ? `${TG_ECHO_MARKER} ${line}` : `❯ ${line}`;
}

export function labelTelegramLine(text: string): string {
  return `[${TG_LABEL}] ${text}`;
}

export const REMOTE_FOOTER = [
  { key: "o", label: "turn on/off" },
  { key: "←/→", label: "tab" },
  { key: "esc", label: "close" },
] as const;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function isRemoteControlCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === REMOTE_CONTROL_COMMAND;
}

export type RemoteControlRequest =
  | { action: "status" }
  | { action: "off" }
  | { action: "on"; name?: string }
  | { action: "invalid"; message: string };

export const REMOTE_CONTROL_USAGE = `Usage: ${REMOTE_CONTROL_COMMAND} [name|off|status]`;

/**
 * `/remote-control` and `/remote-control status` read; `off` stops; anything
 * else is the topic name to start with (`on` starts with a name serve picks).
 * Starting always needs the explicit word: the bare command never starts it.
 */
export function parseRemoteControlArgs(line: string): RemoteControlRequest {
  const words = line.trim().split(/\s+/).slice(1);
  if (words.length === 0) return { action: "status" };
  if (words.length > 1) return { action: "invalid", message: REMOTE_CONTROL_USAGE };
  const word = words[0] as string;
  const lower = word.toLowerCase();
  if (lower === "status") return { action: "status" };
  if (lower === "off") return { action: "off" };
  if (lower === "on") return { action: "on" };
  return { action: "on", name: word };
}

// ---------------------------------------------------------------------------
// Shared text
// ---------------------------------------------------------------------------

/** `12s`, `3m`, `2h`; the unit that reads shortest. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

const STATE_WORDS: Record<RemoteState, string> = { off: "off", on: "on", offline: "offline" };

/** One status block: state, topic, heartbeat age and what turns it on or off. `posture` adds the Telegram permission lines (flow 396). */
export function formatRemoteStatusLines(status: RemoteStatus, posture?: readonly string[]): string[] {
  const lines = [`Remote control: ${STATE_WORDS[status.state]}`];
  if (status.state === "off") {
    lines.push("Topic: none");
    lines.push(`Turn it on with ${REMOTE_CONTROL_COMMAND} <name>, or press o here.`);
    return lines;
  }
  lines.push(`Topic: ${status.name ?? "registering"}`);
  lines.push(`Last heartbeat: ${status.heartbeatAgeMs === undefined ? "none yet" : `${formatAge(status.heartbeatAgeMs)} ago`}`);
  if (status.state === "offline") lines.push("Serve is not reachable. The shell keeps retrying; nothing is lost from Telegram.");
  if (status.unconfirmedApprovals !== undefined && status.unconfirmedApprovals > 0) {
    const n = status.unconfirmedApprovals;
    lines.push(`Approvals not confirmed: ${n}. The topic shows ${n === 1 ? "it" : "them"} as "not confirmed" until serve takes the shell's ack.`);
  }
  lines.push(`Turn it off with ${REMOTE_CONTROL_COMMAND} off, or press o here. Rename: ${REMOTE_CONTROL_COMMAND} off, then ${REMOTE_CONTROL_COMMAND} <name>.`);
  if (posture !== undefined && posture.length > 0) {
    lines.push("", "Telegram permissions (change with /remote-policy):", ...posture.map((line) => `  ${line}`));
  }
  return lines;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** Recent events, newest first; one line each. */
export function formatRemoteEventLines(status: RemoteStatus): string[] {
  if (status.events.length === 0) return ["No remote events yet."];
  return [...status.events].reverse().slice(0, REMOTE_EVENT_LIMIT).map((event: RemoteEvent) => `${clock(event.at)}  ${event.kind.padEnd(8)} ${event.text}`);
}

/**
 * Flow 387: the recent slash commands that came from the topic, newest first. Refused commands and
 * confirmations still waiting for a press are in it, because the router records both as "command"
 * events. A confirmation that was answered or has expired is followed by a later line for the same
 * command; the waiting line stays in the list as the history of what was asked.
 */
export function formatRemoteCommandLines(status: RemoteStatus): string[] {
  const commands = status.events.filter((event) => event.kind === "command");
  if (commands.length === 0) return ["No remote commands yet."];
  return [...commands].reverse().slice(0, REMOTE_EVENT_LIMIT).map((event: RemoteEvent) => `${clock(event.at)}  ${event.text}`);
}

/** The readline shell's `/remote-control`: the status block, then the recent events. */
export function renderRemoteControlText(status: RemoteStatus): string {
  return `${[...formatRemoteStatusLines(status), "", "Recent events:", ...formatRemoteEventLines(status)].join("\n")}\n`;
}

/**
 * The readline shell's whole `/remote-control`. That shell has no session bridge, so remote
 * control is always off there and cannot be started from it: it says so and points at the
 * full-screen shell, where the same command turns it on.
 */
export function readlineRemoteControlText(line: string): string {
  const request = parseRemoteControlArgs(line);
  if (request.action === "invalid") return `${request.message}\n`;
  const off = renderRemoteControlText({ state: "off", events: [] });
  if (request.action === "on") {
    return `Remote control starts only in the full-screen shell: run \`keryx shell\` and use ${REMOTE_CONTROL_COMMAND} <name> there. Here it is off.\n${off}`;
  }
  return off;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export const REMOTE_TABS = [
  { id: "status", label: "Status" },
  { id: "events", label: "Events" },
  { id: "commands", label: "Commands" },
] as const;

export type PresentRemoteOptions = {
  getStatus: () => RemoteStatus;
  /** The Telegram permission lines for the Status tab (flow 396). */
  getPostureLines?: () => readonly string[] | undefined;
  /** Turn it on (with the name serve picks) when off, off when on. Same code as the typed command. */
  onToggle: () => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

function paint(otui: unknown, renderer: unknown, body: unknown, id: string, content: string): { content: string } | undefined {
  const parent = body as { add?: (child: unknown) => void } | undefined | null;
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } } | undefined | null)
    ?.TextRenderable;
  if (parent?.add === undefined || ctor === undefined) return undefined;
  const node = new ctor(renderer, { id, content });
  parent.add(node);
  return node;
}

export function presentRemoteControl(
  open: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentRemoteOptions,
): ModalHandle | undefined {
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);
  let scroll = 0;
  let width: number | undefined;
  let current = "status";
  const nodes = new Map<string, { content: string }>();
  let unsubscribeKey: (() => void) | undefined;

  const linesFor = (tab: string): string[] => {
    const status = options.getStatus();
    if (tab === "events") return formatRemoteEventLines(status);
    if (tab === "commands") return formatRemoteCommandLines(status);
    return formatRemoteStatusLines(status, options.getPostureLines?.());
  };
  const content = (tab: string): string => {
    const lines = linesFor(tab);
    scroll = clampScroll(scroll, lines.length, bodyRows);
    return wrapLines(windowLines(lines, scroll, bodyRows).join("\n"), width);
  };
  const repaint = (): void => {
    const node = nodes.get(current);
    if (node !== undefined) node.content = content(current);
  };

  const handle = open(otui, chrome, {
    title: REMOTE_CONTROL_COMMAND,
    tabs: REMOTE_TABS,
    initialTab: "status",
    footer: REMOTE_FOOTER,
    renderTab: (tabId, body, ctx) => {
      width = ctx?.width;
      current = tabId;
      scroll = 0;
      const node = paint(otui, options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer, body, `remote-${tabId}`, content(tabId));
      if (node !== undefined) nodes.set(tabId, node);
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) return undefined;
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      if (token === "o") {
        options.onToggle();
        // The toggle is asynchronous (it registers or deregisters); the panel
        // repaints on the next key or tab switch, and the sidebar row follows
        // the bridge's own change notice.
        repaint();
        return;
      }
      const lines = linesFor(current).length;
      const step = token === "up" || token === "k" ? -1 : token === "down" || token === "j" ? 1 : 0;
      if (step === 0) return;
      scroll = clampScroll(scroll + step, lines, bodyRows);
      repaint();
    });
  }
  return handle;
}

export type OpenRemoteOptions = PresentRemoteOptions;

/** Open the modal over the live bridge status. */
export function openRemoteControl(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: OpenRemoteOptions,
): ModalHandle | undefined {
  return presentRemoteControl(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export interface RemoteRow {
  /** The value shown after the "Remote" label: `off`, the topic name, or `offline`. */
  readonly text: string;
  readonly role: TextRole;
  /** A click always opens the modal: that is where it is turned on or off. */
  readonly action: "open";
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** `Remote: off | <topic name> | offline`, as the value half of the row. */
export function projectRemoteRow(status: RemoteStatus | undefined, width: number): RemoteRow {
  if (status === undefined || status.state === "off") return { text: fit("off", width), role: "muted", action: "open" };
  if (status.state === "offline") return { text: fit("offline", width), role: "attention", action: "open" };
  const topic = status.name ?? "connecting";
  const unconfirmed = status.unconfirmedApprovals ?? 0;
  // Flow 397: a decision serve has not confirmed is attention, not "ok": the topic shows it as "not confirmed".
  if (unconfirmed > 0) return { text: fit(`${topic} · ${unconfirmed} unconfirmed`, width), role: "attention", action: "open" };
  return { text: fit(topic, width), role: "ok", action: "open" };
}

/** The posture line under the Remote row: only while remote control is on or retrying, and only when there is something to say. */
export function projectPostureLine(status: RemoteStatus | undefined, posture: string | undefined, width: number): string | undefined {
  if (status === undefined || status.state === "off" || posture === undefined || posture.length === 0) return undefined;
  return posture
    .split("\n")
    .map((line) => fit(line, width))
    .join("\n");
}

type PanelParent = { add(child: unknown): void };
type TextNode = { content: unknown; onMouseDown?: (() => void) | undefined };

export interface RemotePanelOptions {
  width: number;
  getStatus: () => RemoteStatus;
  onOpen: () => void;
  /**
   * Flow 396: the Telegram permission posture, one line under the row (`trust · no limit · wait 15m`).
   * Painted only while remote control is on; `undefined` hides the line so the sidebar keeps its height.
   */
  getPosture?: () => string | undefined;
  /** A click on the posture line (the saved-rule count lives there) opens `/permissions`. */
  onOpenPermissions?: () => void;
}

export interface RemotePanelHandle {
  /** Repaint from the current status (the host calls it on every bridge change). */
  refresh(): void;
  row(): RemoteRow;
  activate(): "open";
  dispose(): void;
}

export function mountRemotePanel(otui: unknown, renderer: unknown, parent: unknown, options: RemotePanelOptions): RemotePanelHandle {
  const core = otui as OpenTui;
  const box = new core.BoxRenderable(renderer as never, { id: "sb-remote", flexDirection: "column", flexShrink: 0 });
  (parent as PanelParent).add(box);
  let disposed = false;

  const label = new core.TextRenderable(renderer as never, {
    id: "sb-remote-k",
    content: core.t`${dimChunk(core, "Remote")}`,
    marginTop: 1,
  });
  const value = new core.TextRenderable(renderer as never, { id: "sb-remote-v", content: "" }) as unknown as TextNode;
  box.add(label);
  box.add(value as never);
  const posture = new core.TextRenderable(renderer as never, { id: "sb-remote-p", content: "" }) as unknown as TextNode & { visible?: boolean };
  box.add(posture as never);

  const currentRow = (): RemoteRow => projectRemoteRow(options.getStatus(), options.width);
  const draw = (): void => {
    if (disposed) return;
    const row = currentRow();
    label.content = core.t`${dimChunk(core, "Remote")}`;
    value.content = core.t`${roleChunk(core, row.role, row.text)}`;
    const line = projectPostureLine(options.getStatus(), options.getPosture?.(), options.width);
    posture.content = line === undefined ? "" : core.t`${dimChunk(core, line)}`;
    posture.visible = line !== undefined;
  };
  const activate = (): "open" => {
    options.onOpen();
    return "open";
  };
  label.onMouseDown = () => {
    activate();
  };
  value.onMouseDown = () => {
    activate();
  };
  posture.onMouseDown = () => {
    options.onOpenPermissions?.();
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("remote-panel", draw, () => disposed || isRenderableGone(box)));
  draw();

  return {
    refresh: draw,
    row: currentRow,
    activate,
    dispose() {
      disposed = true;
      unsubscribeTheme();
    },
  };
}

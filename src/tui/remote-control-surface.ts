// `/remote-control`: the TUI and readline halves of the shell's remote control
// (flow 376, AC3/AC12). The sidebar row, the modal, the slash command's text
// and the readline text are all built from one `RemoteStatus`, so no surface
// states something the others do not.
//
// Remote control is OFF unless this command turned it on. Nothing here starts
// it: `presentRemoteControl` and the panel only ask the host to (`onToggle`,
// `onOpen`), and the host runs the same code the typed command runs.

import { type RemoteStatus } from "../remote/shell-bridge";
import { waitingCardsText } from "./operator-confirmations";
import { clampScroll, wrapLines, windowLines, type ModalHandle, type OpenModalFn } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { onThemeChange, type TextRole } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";
export { REMOTE_CONTROL_COMMAND, REMOTE_CONTROL_SUMMARY, hubShareUsage, parseHubShareCommand, TG_LABEL, TG_ECHO_MARKER, commandEchoText, labelTelegramLine, REMOTE_FOOTER, isRemoteControlCommand, REMOTE_CONTROL_USAGE, parseRemoteControlArgs, formatAge, formatHistoryStatus, formatRemoteStatusLines, formatRemoteEventLines, formatRemoteCommandLines, renderRemoteControlText, readlineRemoteControlText } from "./remote-control-text";
export type { HubShareAction, RemoteControlRequest } from "./remote-control-text";
import { clock, REMOTE_CONTROL_COMMAND, REMOTE_FOOTER, formatRemoteStatusLines, formatRemoteEventLines, formatRemoteCommandLines } from "./remote-control-text";

type OpenTui = typeof import("@opentui/core");


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
  /** Flow 464 (AC6): the pending and recently answered operator cards, one line each, heading first. */
  getConfirmationLines?: () => readonly string[] | undefined;
  /** Turn it on (with the name serve picks) when off, off when on. Same code as the typed command. */
  onToggle: () => void;
  /**
   * Post the session's history to the topic (the `h` key). Same code as the typed `/history`.
   * Returns a promise that settles when the posts are done (a paced run takes a while): the
   * modal shows that it is working, then repaints with the answer (a line for usage, empty
   * history or remote control off) or with the new status when it is undefined.
   */
  onHistory?: () => void | Promise<string | undefined>;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  /**
   * Subscribe to the bridge's change notices (a decision confirmed or aged out, a state change):
   * the open modal repaints on each, so "Approvals not confirmed: N" appears and clears without a
   * keypress. Returns the unsubscribe, called when the modal closes.
   */
  subscribeChange?: (listener: () => void) => () => void;
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

/** Shown in the status tab while the history posts are running. */
export const HISTORY_POSTING_NOTE = "Posting the history to the topic, a message every couple of seconds. This line updates when it is done.";

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
  let unsubscribeChange: (() => void) | undefined = undefined;
  /** What the last `h` press says: that it is posting, or why nothing was posted. Shown in the status tab. */
  let historyNote: string | undefined;
  let postingHistory = false;
  let closed = false;

  const linesFor = (tab: string): string[] => {
    const status = options.getStatus();
    if (tab === "events") return formatRemoteEventLines(status);
    if (tab === "commands") return formatRemoteCommandLines(status);
    const lines = formatRemoteStatusLines(status, options.getPostureLines?.(), options.getConfirmationLines?.());
    if (historyNote !== undefined) {
      const at = lines.findIndex((line) => line.startsWith("History:"));
      lines.splice(at < 0 ? lines.length : at + 1, 0, historyNote);
    }
    return lines;
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
      closed = true;
      unsubscribeKey?.();
      unsubscribeChange?.();
    },
  });
  if (handle === undefined) return undefined;
  unsubscribeChange = options.subscribeChange?.(() => {
    if (!closed) repaint();
  });
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
      if (token === "h") {
        if (postingHistory) return;
        const running = options.onHistory?.();
        if (running !== undefined && typeof running.then === "function") {
          // The posts are paced and take a while: say so now, repaint when they are done, so the
          // History line is never left showing the state from before the press.
          postingHistory = true;
          historyNote = HISTORY_POSTING_NOTE;
          repaint();
          void running
            .then(
              (answer) => {
                historyNote = answer;
              },
              () => {
                historyNote = "The history could not be posted.";
              },
            )
            .then(() => {
              postingHistory = false;
              if (!closed) repaint();
            });
          return;
        }
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
  /** `history 10 · 06:52` once the history was posted to this topic (flow 399); absent otherwise. */
  readonly detail?: string;
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** `Remote: off | <topic name> | offline`, as the value half of the row. */
export function projectRemoteRow(status: RemoteStatus | undefined, width: number, waitingCards = 0): RemoteRow {
  if (status === undefined || status.state === "off") return { text: fit("off", width), role: "muted", action: "open" };
  const detail = status.history === undefined ? {} : { detail: fit(`history ${status.history.count} · ${clock(status.history.at).slice(0, 5)}`, width) };
  if (status.state === "offline") return { text: fit("offline", width), role: "attention", action: "open", ...detail };
  const topic = status.name ?? "connecting";
  const unconfirmed = status.unconfirmedApprovals ?? 0;
  // Flow 464 (AC6): an operator card waiting for a press in the topic is attention, like an unconfirmed decision.
  const cards = waitingCardsText(waitingCards);
  if (cards !== undefined) return { text: fit(`${topic} · ${cards}`, width), role: "attention", action: "open", ...detail };
  // Flow 397: a decision serve has not confirmed is attention, not "ok": the topic shows it as "not confirmed".
  if (unconfirmed > 0) return { text: fit(`${topic} · ${unconfirmed} unconfirmed`, width), role: "attention", action: "open", ...detail };
  return { text: fit(topic, width), role: "ok", action: "open", ...detail };
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
  /** Flow 464 (AC6): how many operator cards wait for a press in the topic. */
  getWaitingCards?: () => number;
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
  const detail = new core.TextRenderable(renderer as never, { id: "sb-remote-h", content: "" }) as unknown as TextNode;
  box.add(label);
  box.add(value as never);
  box.add(detail as never);
  const posture = new core.TextRenderable(renderer as never, { id: "sb-remote-p", content: "" }) as unknown as TextNode & { visible?: boolean };
  box.add(posture as never);

  const currentRow = (): RemoteRow => projectRemoteRow(options.getStatus(), options.width, options.getWaitingCards?.() ?? 0);
  const draw = (): void => {
    if (disposed) return;
    const row = currentRow();
    label.content = core.t`${dimChunk(core, "Remote")}`;
    value.content = core.t`${roleChunk(core, row.role, row.text)}`;
    detail.content = row.detail === undefined ? "" : core.t`${dimChunk(core, row.detail)}`;
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
  detail.onMouseDown = () => {
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

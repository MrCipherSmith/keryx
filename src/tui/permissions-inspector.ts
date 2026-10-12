// Flow 396: the `/permissions` modal. The saved shell rules an Always answer leaves behind, from the
// shell or from Telegram: the ones that run without asking, the ones the validators no longer honour
// (with the reason), and the grants made for this session only. `d` arms the removal of the selected
// rule and `y` confirms it, so one stray key never takes a rule back. The file is the source of
// truth: every paint reads it again, nothing here keeps a copy of a rule.

import {
  loadPermissionsView,
  patternOnOneLine,
  removePermission,
  type PermissionRow,
  type PermissionsView,
  type RemoveResult,
} from "../commands/permissions-command";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const PERMISSIONS_COMMAND = "/permissions";

export function isPermissionsCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === PERMISSIONS_COMMAND;
}

export const PERMISSIONS_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "d", label: "remove" },
  { key: "y", label: "confirm" },
  { key: "esc", label: "close" },
] as const;

export interface PermissionsModalView {
  rows: PermissionRow[];
  lines: string[];
  /** The line each row starts on, for scrolling it into view. */
  rowStart: number[];
}

export function formatPermissionsModal(view: PermissionsView, selected: number, notice?: string): PermissionsModalView {
  const lines: string[] = [];
  const rowStart: number[] = [];
  const active = view.rows.filter((row) => row.kind === "active").length;
  lines.push(
    view.rows.length === 0
      ? "No saved shell rules: every command that is not read-only asks first."
      : `Saved shell rules (${active}) - d removes the selected one, it asks again from then on`,
  );
  if (notice !== undefined && notice.length > 0) lines.push(notice);
  lines.push("");
  let section: PermissionRow["kind"] | undefined;
  view.rows.forEach((row, index) => {
    if (row.kind !== section) {
      section = row.kind;
      if (row.kind === "inactive") lines.push("Not honoured: kept in the file, they approve nothing", "");
      if (row.kind === "session") lines.push("Granted for this session only", "");
    }
    rowStart.push(lines.length);
    lines.push(`${index === selected ? ">" : " "} ${row.n}. ${patternOnOneLine(row.pattern)}`);
    if (row.reason !== undefined) lines.push(`     ${row.reason}`);
    lines.push("");
  });
  lines.push(`File: ${view.path}`);
  return { rows: view.rows, lines, rowStart };
}

export interface PermissionsModalOptions {
  /** Reads the rules again on each paint and reload. */
  load?: () => PermissionsView;
  /** Removes one rule; the shell passes one that also clears its own session set. */
  remove?: (pattern: string) => RemoveResult;
  /** The session set, so grants made for this session show up and can be removed. */
  sessionAllow?: Set<string>;
  /** Runs after a rule was removed by the default `remove`, so the sidebar count and the tamper fingerprint follow. */
  onChanged?: () => void;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  inputBlocked?: () => boolean;
}

export interface PermissionsModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
  selected(): PermissionRow | undefined;
  reload(): void;
}

export function openPermissions(otui: unknown, chrome: unknown, options: PermissionsModalOptions): PermissionsModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);
  const load =
    options.load ?? ((): PermissionsView => loadPermissionsView(options.sessionAllow !== undefined ? { sessionAllow: options.sessionAllow } : {}));
  const remove =
    options.remove ??
    ((target: string): RemoveResult =>
      removePermission(target, {
        ...(options.sessionAllow !== undefined ? { sessionAllow: options.sessionAllow } : {}),
        ...(options.onChanged !== undefined ? { onChanged: options.onChanged } : {}),
      }));

  let selected = 0;
  let scroll = 0;
  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  let notice: string | undefined;
  let armed: string | undefined;
  const keys: { off?: () => void } = {};

  const model = (): PermissionsModalView =>
    formatPermissionsModal(load(), selected, armed !== undefined ? `Remove ${patternOnOneLine(armed)}? press y to confirm, any other key cancels` : notice);
  const clampSelected = (rows: number): void => {
    selected = Math.min(Math.max(0, rows - 1), Math.max(0, selected));
  };
  const visible = (): string[] => {
    const view = model();
    clampSelected(view.rows.length);
    return windowLines(wrapLines(view.lines.join("\n"), width).split("\n"), scroll, bodyRows);
  };
  const paint = (): void => {
    if (closed) return;
    const view = model();
    clampSelected(view.rows.length);
    const wrapped = wrapLines(view.lines.join("\n"), width).split("\n");
    const start = view.rowStart[selected] ?? 0;
    scroll = clampScroll(scrollToReveal(start, scroll, bodyRows), wrapped.length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, windowLines(wrapped, scroll, bodyRows).join("\n"))}`;
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: PERMISSIONS_COMMAND,
    tabs: [{ id: "rules", label: "Shell rules" }],
    footer: PERMISSIONS_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "permissions-body", content: "" }) as never;
      parent.add(bodyNode);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  const modal = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "permissions-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  const selectedRow = (): PermissionRow | undefined => model().rows[selected];

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (armed !== undefined) {
      const pattern = armed;
      armed = undefined;
      if (token === "y") {
        notice = remove(pattern).text;
      }
      paint();
      return;
    }
    if (token === "up" || token === "k") {
      selected = Math.max(0, selected - 1);
      notice = undefined;
    } else if (token === "down" || token === "j") {
      selected += 1;
      notice = undefined;
    } else if (token === "d") {
      const row = selectedRow();
      if (row === undefined) notice = "Nothing to remove.";
      else armed = row.pattern;
    } else {
      return;
    }
    paint();
  });

  return {
    ...modal,
    visibleLines: visible,
    selected: selectedRow,
    reload: () => {
      paint();
    },
  };
}

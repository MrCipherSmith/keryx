// Flow 374: the `/settings` modal, drawn like `/connect`'s row list — one block
// per setting, value buttons built by the same `smallActionButton`, ↑/↓ between
// rows, ←/→ between buttons, Enter to press, Esc to leave.
//
// The modal decides nothing about a setting. A press hands the button's slash
// line to `run` (the shell's own handler for that command), then asks `load`
// for fresh rows, so what the operator sees is what the command left behind.
// Read side and write side are both injected, the same split every
// `*-inspector.ts` here holds, which keeps this file free of disk I/O.
//
// Selecting `auto` permission mode needs a second Enter (or click), the way
// `/connect`'s Disconnect does: one keypress never reaches it.

import { smallActionButton } from "./action-button";
import { openModal, type ModalHandle } from "./modal-host";
import { clampQueueNavIndex, stepQueueNavIndex } from "./queue-nav";
import type { SettingRow } from "./settings-model";
import { getTheme, onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { boldChunk, dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Box = InstanceType<OpenTui["BoxRenderable"]>;

export const SETTINGS_COMMAND = "/settings";

export function isSettingsCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === SETTINGS_COMMAND;
}

/**
 * The sidebar's pointer at `/settings`, shown after the mode. The read-only
 * marker takes the place of it: that is the state an operator must not miss,
 * and the sidebar has no room for both.
 */
export function settingsSidebarHint(readOnlyShown: boolean): string | undefined {
  return readOnlyShown ? undefined : SETTINGS_COMMAND;
}

export const SETTINGS_FOOTER = [
  { key: "↑/↓", label: "setting" },
  { key: "←/→", label: "value" },
  { key: "Enter", label: "apply" },
  { key: "esc", label: "close" },
] as const;

export interface SettingsModalOptions {
  rows: readonly SettingRow[];
  /** Fresh rows, read after every press. */
  load: () => Promise<readonly SettingRow[]>;
  /** Run one button's slash line through the command's own handler; resolves once its effect has landed. */
  run: (command: string) => Promise<void>;
  renderer: Parameters<typeof smallActionButton>[1];
  onKeypress: (
    handler: (key: { name: string; sequence: string; preventDefault?: () => void; stopPropagation?: () => void }) => void,
  ) => () => void;
  inputBlocked?: () => boolean;
}

interface Window {
  top: number;
  end: number;
}

/** Lines one setting takes: its own two, plus a group heading when it opens a group or the window. */
const lineCount = (rows: readonly SettingRow[], from: number, to: number): number => {
  let lines = 0;
  for (let i = from; i <= to; i++) {
    lines += 2 + (i === from || rows[i - 1]!.group !== rows[i]!.group ? 1 : 0);
  }
  return lines;
};

/** The slice of `rows` that fits `budget` lines while keeping `selected` on screen. */
export function settingsWindow(rows: readonly SettingRow[], selected: number, top: number, budget: number): Window {
  let start = Math.min(top, selected);
  while (start < selected && lineCount(rows, start, selected) > budget) start++;
  let end = start;
  while (end + 1 < rows.length && lineCount(rows, start, end + 1) <= budget) end++;
  return { top: start, end };
}

export function openSettings(otui: unknown, chrome: unknown, options: SettingsModalOptions): ModalHandle | undefined {
  const core = otui as OpenTui;
  const r = options.renderer;

  let rows: readonly SettingRow[] = options.rows;
  let selectedRow = 0;
  let selectedAction = 0;
  let top = 0;
  let armed: { id: string; action: number } | undefined;
  let busy = false;
  let closed = false;
  let body: Box | undefined;
  let budget = Number.MAX_SAFE_INTEGER;
  let blocks: Box[] = [];

  const activeIndex = (row: SettingRow | undefined): number => Math.max(0, row?.actions.findIndex((a) => a.active) ?? 0);
  const disarm = (): void => {
    armed = undefined;
  };

  function paint(): void {
    if (closed || body === undefined) return;
    for (const block of blocks) {
      try {
        body.remove(block);
      } catch {
        // already detached
      }
    }
    blocks = [];
    selectedRow = clampQueueNavIndex(selectedRow, rows.length);
    const win = settingsWindow(rows, selectedRow, top, budget);
    top = win.top;
    const labelWidth = Math.max(...rows.map((row) => row.label.length));
    const valueWidth = Math.max(...rows.map((row) => row.value.length));
    for (let i = win.top; i <= win.end; i++) {
      const row = rows[i]!;
      const selected = i === selectedRow;
      if (i === win.top || rows[i - 1]!.group !== row.group) {
        const heading = new core.TextRenderable(r, { id: `st-group-${row.group}`, content: core.t`${boldChunk(core, row.group)}` });
        body.add(heading);
        blocks.push(heading as unknown as Box);
      }
      const outer = new core.BoxRenderable(r, {
        id: `st-${row.id}`,
        width: "100%",
        flexDirection: "column",
        ...(selected ? { backgroundColor: getTheme().highlight } : {}),
        onMouseDown: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          select(i, activeIndex(row));
        },
      });
      const label = row.label.padEnd(labelWidth);
      const confirming = armed?.id === row.id ? row.actions[armed.action] : undefined;
      const detail = row.detail === undefined ? "" : dimChunk(core, `  ${row.detail}`);
      const armedNote =
        confirming === undefined
          ? ""
          : roleChunk(core, "attention", `  Enter again to confirm ${confirming.label}: it skips confirmation for every action`);
      outer.add(
        new core.TextRenderable(r, {
          id: `st-${row.id}-line`,
          marginLeft: 2,
          content: core.t`${selected ? boldChunk(core, label) : label}  ${roleChunk(core, "ok", row.value.padEnd(valueWidth))}  ${dimChunk(core, `[${row.scope}]`)}${detail}${armedNote}`,
        }),
      );
      const buttons = new core.BoxRenderable(r, { id: `st-${row.id}-buttons`, width: "100%", flexDirection: "row", marginLeft: 1 });
      if (row.actions.length === 0) {
        buttons.add(new core.TextRenderable(r, { id: `st-${row.id}-hint`, marginLeft: 1, content: core.t`${dimChunk(core, `run ${row.usage}`)}` }));
      }
      row.actions.forEach((action, index) => {
        const color = action.active ? getTheme().ok : action.confirm ? getTheme().error : getTheme().tool;
        const button = smallActionButton(core, r, action.active ? `✓ ${action.label}` : action.label, `st-${row.id}-${index}`, color, () => {
          select(i, index);
          void press();
        });
        button.setActive(selected && index === selectedAction);
        buttons.add(button.box);
      });
      outer.add(buttons);
      body.add(outer);
      blocks.push(outer);
    }
  }

  function select(row: number, action: number): void {
    if (row !== selectedRow || action !== selectedAction) disarm();
    selectedRow = row;
    selectedAction = action;
    paint();
  }

  async function press(): Promise<void> {
    const row = rows[selectedRow];
    const action = row?.actions[selectedAction];
    if (row === undefined || action === undefined || busy) return;
    if (action.confirm && (armed?.id !== row.id || armed.action !== selectedAction)) {
      armed = { id: row.id, action: selectedAction };
      paint();
      return;
    }
    disarm();
    busy = true;
    try {
      await options.run(action.command);
      rows = await options.load();
    } catch {
      // The command reports its own failure; the rows below stay as they were.
    } finally {
      busy = false;
    }
    const at = rows.findIndex((candidate) => candidate.id === row.id);
    if (at >= 0) selectedRow = at;
    selectedAction = clampQueueNavIndex(selectedAction, rows[selectedRow]?.actions.length ?? 0);
    paint();
  }

  const swallow = (key: { preventDefault?: () => void; stopPropagation?: () => void }): void => {
    key.preventDefault?.();
    key.stopPropagation?.();
  };

  // Registered BEFORE the modal host so an armed confirmation swallows Esc first
  // (the way `/connect`'s Disconnect does); otherwise Esc falls through and closes.
  const unsubscribeKeys = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    if (key.name === "escape") {
      if (armed === undefined) return;
      disarm();
      paint();
      swallow(key);
      return;
    }
    if (busy) return;
    const row = rows[selectedRow];
    if (key.name === "up" || key.name === "down") {
      const next = stepQueueNavIndex(selectedRow, rows.length, key.name);
      select(next, activeIndex(rows[next]));
    } else if (key.name === "left" || key.name === "right") {
      const count = row?.actions.length ?? 0;
      if (count > 0) select(selectedRow, stepQueueNavIndex(selectedAction, count, key.name === "left" ? "up" : "down"));
    } else if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
      void press();
    } else {
      return;
    }
    swallow(key);
  });

  let unsubscribeTheme: () => void = () => {};
  const groups = new Set(rows.map((row) => row.group)).size;
  selectedAction = activeIndex(rows[0]);
  const handle = openModal(core, chrome as never, {
    title: SETTINGS_COMMAND,
    tabs: [{ id: "settings", label: "Settings" }],
    footer: SETTINGS_FOOTER,
    contentRows: rows.length * 2 + groups,
    renderTab: (_tabId, tabBody, ctx) => {
      body = tabBody as Box;
      budget = ctx.height;
      blocks = [];
      paint();
    },
    onClose: () => {
      closed = true;
      unsubscribeKeys();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) {
    unsubscribeKeys();
    return undefined;
  }
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "settings-modal",
      paint,
      () => closed || isRenderableGone(body) || (r as { isDestroyed?: boolean }).isDestroyed === true,
    ),
  );
  return handle;
}

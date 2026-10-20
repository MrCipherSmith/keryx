// Sidebar geometry store (flow 468 phase C).
//
// The sidebar used to be one fixed column (`SIDEBAR_WIDTH`). It now has three
// modes the operator switches between: `default` (today's column), `wide` (twice
// that, never more than half the terminal) and `rail` (a thin strip). This module
// owns the mode, the width it implies for a given terminal, the notification of
// whoever paints with it, and the persisted choice. It is pure state: no
// renderer, no `@opentui/core`.
//
// `state().mode` is the EFFECTIVE mode; `state().preferred` is what the operator
// chose. They differ only when `wide` was chosen on a terminal narrower than
// {@link SIDEBAR_WIDE_MIN_COLUMNS}: the sidebar then shows `default` and goes back
// to `wide` the moment there is room again, without the choice being lost.
// `setMode` and `cycle` persist the PREFERRED mode; `resize` never writes.
import { mergeTuiConfig, readTuiConfig } from "./theme";
import { SIDEBAR_WIDTH } from "./sidebar-metrics";

export type SidebarMode = "default" | "wide" | "rail";

/** Cycle order of the keyboard shortcut. */
export const SIDEBAR_MODES: readonly SidebarMode[] = ["default", "wide", "rail"];
/** Wide is twice today's column (and then capped at half the terminal). */
export const SIDEBAR_WIDE_WIDTH = SIDEBAR_WIDTH * 2;
/** One icon and a badge per card: border (1) + padding (1) + 3 text cells. */
export const SIDEBAR_RAIL_WIDTH = 5;
/**
 * Terminal width below which `wide` shows `default`. At 100 columns wide is 50
 * (half the terminal) and the transcript keeps 50 — the narrowest split where a
 * wide sidebar still leaves a usable conversation column.
 */
export const SIDEBAR_WIDE_MIN_COLUMNS = 100;

/** Columns of border + padding the sidebar box takes before any text (1 + 2 + 1). */
const SIDEBAR_CHROME_COLUMNS = 4;

export interface SidebarGeometryState {
  /** The mode being shown. */
  mode: SidebarMode;
  /** The mode the operator chose (what is saved). */
  preferred: SidebarMode;
  /** Columns the sidebar box takes. */
  width: number;
}

export interface SidebarGeometry {
  state(): SidebarGeometryState;
  /** Choose a mode: notifies if the shown mode or width changed, and persists the choice. */
  setMode(mode: SidebarMode): void;
  /** Move to the next mode in {@link SIDEBAR_MODES}; returns the new preferred mode. */
  cycle(): SidebarMode;
  /** The terminal changed width: re-clamp. Never writes. */
  resize(columns: number): void;
  /** Listener fires only when the shown mode or the width changed. Returns the unsubscribe. */
  subscribe(listener: (state: SidebarGeometryState) => void): () => void;
}

export interface SidebarGeometryOptions {
  columns: number;
  /** Config directory holding `tui.json` (the test seam; default: the user's). */
  configDir?: string | undefined;
  /** Start in this mode instead of the persisted one. */
  mode?: SidebarMode | undefined;
}

function isSidebarMode(value: unknown): value is SidebarMode {
  return typeof value === "string" && (SIDEBAR_MODES as readonly string[]).includes(value);
}

/** The saved mode; anything unknown, corrupt or missing is `default`. Never throws. */
export function loadPersistedSidebarMode(dir?: string): SidebarMode {
  const value = readTuiConfig(dir).sidebar;
  return isSidebarMode(value) ? value : "default";
}

/** Save the mode under the `sidebar` key of `tui.json`, keeping the theme and any other key. */
export function persistSidebarMode(mode: SidebarMode, dir?: string): void {
  mergeTuiConfig({ sidebar: mode }, dir);
}

/**
 * Single-cell mode icon (a button in the pinned header). `ascii` is the fallback
 * for terminals without the glyphs: distinct, printable, one cell.
 */
export function sidebarModeIcon(mode: SidebarMode, ascii = false): string {
  if (ascii) {
    return mode === "default" ? "-" : mode === "wide" ? "=" : "|";
  }
  return mode === "default" ? "▢" : mode === "wide" ? "▭" : "▕";
}

/** Columns of TEXT a sidebar of `width` gives a panel (34 -> 30): the width less border and padding. */
export function sidebarTextWidth(width: number): number {
  return Math.max(1, width - SIDEBAR_CHROME_COLUMNS);
}

function layoutFor(preferred: SidebarMode, columns: number): { mode: SidebarMode; width: number } {
  if (preferred === "rail") {
    return { mode: "rail", width: SIDEBAR_RAIL_WIDTH };
  }
  if (preferred === "wide" && columns >= SIDEBAR_WIDE_MIN_COLUMNS) {
    return { mode: "wide", width: Math.min(SIDEBAR_WIDE_WIDTH, Math.floor(columns / 2)) };
  }
  return { mode: "default", width: SIDEBAR_WIDTH };
}

export function createSidebarGeometry(opts: SidebarGeometryOptions): SidebarGeometry {
  const configDir = opts.configDir;
  let columns = opts.columns;
  let preferred: SidebarMode = opts.mode ?? loadPersistedSidebarMode(configDir);
  let shown = layoutFor(preferred, columns);
  const listeners = new Set<(state: SidebarGeometryState) => void>();

  const state = (): SidebarGeometryState => ({ mode: shown.mode, preferred, width: shown.width });

  const apply = (): void => {
    const next = layoutFor(preferred, columns);
    const changed = next.mode !== shown.mode || next.width !== shown.width;
    shown = next;
    if (!changed) return;
    const snapshot = state();
    for (const listener of [...listeners]) {
      listener(snapshot);
    }
  };

  const setMode = (mode: SidebarMode): void => {
    preferred = mode;
    persistSidebarMode(mode, configDir);
    apply();
  };

  return {
    state,
    setMode,
    cycle: () => {
      const index = SIDEBAR_MODES.indexOf(preferred);
      const next = SIDEBAR_MODES[(index + 1) % SIDEBAR_MODES.length] ?? "default";
      setMode(next);
      return next;
    },
    resize: (nextColumns) => {
      if (nextColumns === columns) return;
      columns = nextColumns;
      apply();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Per-viewer UI preferences in localStorage (theme, appearance, send key, sidebar).
// Conveniences only: everything works with storage unavailable.

import { useSyncExternalStore } from "react";

export type UiFont = "system" | "rounded" | "serif" | "mono";
export type CodeFont = "sf-mono" | "menlo" | "monaco" | "courier";
export type TextSize = "small" | "default" | "large" | "larger";
export type ChatWidth = "narrow" | "wide" | "full";

/** A selectable color theme; its colors live in styles/themes.css under `data-palette`. */
export interface PaletteInfo {
  id: string;
  label: string;
  group: "dark" | "black";
  canvas: string;
  surface: string;
  accent: string;
}

export const PALETTES: readonly PaletteInfo[] = [
  { id: "dark-navy", label: "Navy", group: "dark", canvas: "#20252b", surface: "#292f36", accent: "#a4caff" },
  { id: "dark-ember", label: "Ember", group: "dark", canvas: "#201b1b", surface: "#2b2424", accent: "#ff8f82" },
  { id: "dark-paper", label: "Paper", group: "dark", canvas: "#211c18", surface: "#2d251e", accent: "#f6b39b" },
  { id: "dark-petrol", label: "Petrol", group: "dark", canvas: "#132725", surface: "#1e3330", accent: "#91d9cc" },
  { id: "dark-wine", label: "Wine", group: "dark", canvas: "#271e27", surface: "#352733", accent: "#f2b1c9" },
  { id: "black-mono", label: "Mono", group: "black", canvas: "#000000", surface: "#0f0f0f", accent: "#f5f5f5" },
  { id: "black-navy", label: "Navy", group: "black", canvas: "#000000", surface: "#0a0d12", accent: "#a4caff" },
  { id: "black-petrol", label: "Petrol", group: "black", canvas: "#000000", surface: "#0a1110", accent: "#91d9cc" },
  { id: "black-wine", label: "Wine", group: "black", canvas: "#000000", surface: "#120c11", accent: "#f2b1c9" },
  { id: "black-ember", label: "Ember", group: "black", canvas: "#000000", surface: "#110b0b", accent: "#ff8f82" },
];

export type PaletteId = "default" | (typeof PALETTES)[number]["id"];

export interface Prefs {
  theme: "system" | "light" | "dark";
  /** A custom color theme ("default" = the System / Light / Dark choice above). A custom theme is always dark. */
  palette: PaletteId;
  /** Font of the interface and the conversation. */
  font: UiFont;
  /** Font of code, commands and tool output. */
  codeFont: CodeFont;
  textSize: TextSize;
  /** How wide the conversation and composer run. */
  chatWidth: ChatWidth;
  sendKey: "enter" | "mod-enter";
  sessionSidebar: boolean;
  /** The session sidebar's chosen width in pixels; shown at most a fifth of the window. */
  sessionSidebarWidth: number;
  /** Session sidebar groups the user folded ("Pinned", "Today", a month…). */
  collapsedGroups: string[];
  /** The right side panel's open tab, or null when it is closed (D-13; Activity and Info share it). */
  sidePanel: SidePanelTab | null;
  /** The side panel's width in pixels. */
  sidePanelWidth: number;
  /** Per session: the user's choice to show (true) or fold (false) its subagents in the sidebar; absent = automatic. */
  subagentTree: Record<string, boolean>;
}

export type SidePanelTab = "terminal" | "browser" | "activity" | "info";
const SIDE_TABS: readonly string[] = ["terminal", "browser", "activity", "info"];
export const SIDE_PANEL_MIN = 320;
export const SIDE_PANEL_MAX = 1200;
/** The narrowest the chat column gets while the side panel is open. */
export const CHAT_MIN = 360;
/** The side panel's share of the window, at most. */
export const SIDE_PANEL_SHARE = 0.6;
/** Below this the side panel is too narrow to use; the chat column then gives way. */
const SIDE_PANEL_FLOOR = 240;
/** The project rail's width (`--rail-w`). */
const RAIL_W = 60;

/**
 * The side panel's width in a window `windowWidth` wide, from the stored width: at most 60% of the
 * window, and never so wide that the chat column (next to the session sidebar, `sidebarWidth` when
 * it shows) gets narrower than `CHAT_MIN`. A width stored in a larger window or in full screen
 * therefore no longer squeezes the chat to a sliver.
 */
export function fitSidePanelWidth(stored: number, windowWidth: number, sidebarWidth = 0): number {
  const wanted = Number.isFinite(stored) ? Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, stored)) : SIDE_PANEL_MIN;
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return Math.round(wanted);
  const room = Math.min(Math.floor(windowWidth * SIDE_PANEL_SHARE), windowWidth - RAIL_W - sidebarWidth - CHAT_MIN);
  return Math.round(Math.max(SIDE_PANEL_FLOOR, Math.min(wanted, room)));
}
export const SESSION_SIDEBAR_MIN = 200;
export const SESSION_SIDEBAR_MAX = 560;

const KEY = "keryx.prefs.v1";
const DEFAULTS: Prefs = {
  theme: "system",
  palette: "default",
  font: "system",
  codeFont: "sf-mono",
  textSize: "default",
  chatWidth: "wide",
  sendKey: "enter",
  sessionSidebar: true,
  sessionSidebarWidth: 248,
  collapsedGroups: [],
  sidePanel: null,
  sidePanelWidth: 520,
  subagentTree: {},
};

export const UI_FONTS: Record<UiFont, string> = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif',
  serif: 'ui-serif, "New York", Charter, Georgia, serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
};

export const CODE_FONTS: Record<CodeFont, string> = {
  "sf-mono": 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
  menlo: "Menlo, ui-monospace, monospace",
  monaco: "Monaco, ui-monospace, monospace",
  courier: '"Courier New", Courier, ui-monospace, monospace',
};

export const TEXT_SCALES: Record<TextSize, number> = { small: 0.92, default: 1, large: 1.1, larger: 1.22 };

/** The conversation's measure; "full" runs edge to edge with the usual gutters. */
export const CHAT_WIDTHS: Record<ChatWidth, string> = { narrow: "72ch", wide: "920px", full: "100vw" };

function valid<T extends string>(value: unknown, table: Record<T, unknown>, fallback: T): T {
  return typeof value === "string" && value in table ? (value as T) : fallback;
}

/** The preferences a stored JSON text holds, with every missing or unknown value at its default. */
export function parsePrefs(raw: string | null): Prefs {
  try {
    const stored = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    const { infoPanel, activityWidth: _w, ...known } = stored as Partial<Prefs> & { infoPanel?: unknown; activityWidth?: unknown };
    const merged = { ...DEFAULTS, ...known };
    // A value an older or newer build wrote that this one does not know falls back to the default.
    return {
      ...merged,
      palette:
        typeof merged.palette === "string" && PALETTES.some((p) => p.id === merged.palette) ? merged.palette : DEFAULTS.palette,
      font: valid(merged.font, UI_FONTS, DEFAULTS.font),
      codeFont: valid(merged.codeFont, CODE_FONTS, DEFAULTS.codeFont),
      textSize: valid(merged.textSize, TEXT_SCALES, DEFAULTS.textSize),
      chatWidth: valid(merged.chatWidth, CHAT_WIDTHS, DEFAULTS.chatWidth),
      collapsedGroups: Array.isArray(merged.collapsedGroups) ? merged.collapsedGroups.filter((g) => typeof g === "string") : [],
      // Older builds kept the info panel in its own column (`infoPanel`): it is now the side panel's Info tab.
      sidePanel:
        typeof merged.sidePanel === "string" && SIDE_TABS.includes(merged.sidePanel)
          ? merged.sidePanel
          : infoPanel === true
            ? "info"
            : null,
      sidePanelWidth:
        typeof merged.sidePanelWidth === "number" && Number.isFinite(merged.sidePanelWidth)
          ? Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, merged.sidePanelWidth))
          : DEFAULTS.sidePanelWidth,
      sessionSidebarWidth:
        typeof merged.sessionSidebarWidth === "number" && Number.isFinite(merged.sessionSidebarWidth)
          ? Math.min(SESSION_SIDEBAR_MAX, Math.max(SESSION_SIDEBAR_MIN, merged.sessionSidebarWidth))
          : DEFAULTS.sessionSidebarWidth,
      subagentTree:
        merged.subagentTree && typeof merged.subagentTree === "object" && !Array.isArray(merged.subagentTree)
          ? Object.fromEntries(Object.entries(merged.subagentTree).filter(([, v]) => typeof v === "boolean"))
          : {},
    };
  } catch {
    return DEFAULTS;
  }
}

function read(): Prefs {
  try {
    return parsePrefs(localStorage.getItem(KEY));
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const subs = new Set<() => void>();

/** The current preferences, outside React (event handlers registered once). */
export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep in memory */
  }
  applyTheme();
  subs.forEach((s) => s());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}

/** Theme and appearance onto the root element: `data-theme` and the font, size and width tokens. */
export function applyTheme(): void {
  const root = document.documentElement;
  if (current.palette !== "default") {
    // A custom color theme is dark: it overrides the dark token block by specificity.
    root.setAttribute("data-palette", current.palette);
    root.setAttribute("data-theme", "dark");
  } else {
    root.removeAttribute("data-palette");
    if (current.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", current.theme);
  }
  root.style.setProperty("--font", UI_FONTS[current.font]);
  root.style.setProperty("--mono", CODE_FONTS[current.codeFont]);
  root.style.setProperty("--text-scale", String(TEXT_SCALES[current.textSize]));
  root.style.setProperty("--measure", CHAT_WIDTHS[current.chatWidth]);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

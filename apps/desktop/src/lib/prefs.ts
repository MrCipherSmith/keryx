// Per-viewer UI preferences in localStorage (theme, appearance, send key, sidebar).
// Conveniences only: everything works with storage unavailable.

import { useSyncExternalStore } from "react";

export type UiFont = "system" | "rounded" | "serif" | "mono";
export type CodeFont = "sf-mono" | "menlo" | "monaco" | "courier";
export type TextSize = "small" | "default" | "large" | "larger";
export type ChatWidth = "narrow" | "wide" | "full";

export interface Prefs {
  theme: "system" | "light" | "dark";
  /** Font of the interface and the conversation. */
  font: UiFont;
  /** Font of code, commands and tool output. */
  codeFont: CodeFont;
  textSize: TextSize;
  /** How wide the conversation and composer run. */
  chatWidth: ChatWidth;
  sendKey: "enter" | "mod-enter";
  sessionSidebar: boolean;
  /** The session info panel on the right. */
  infoPanel: boolean;
  /** Session sidebar groups the user folded ("Pinned", "Today", a month…). */
  collapsedGroups: string[];
}

const KEY = "keryx.prefs.v1";
const DEFAULTS: Prefs = {
  theme: "system",
  font: "system",
  codeFont: "sf-mono",
  textSize: "default",
  chatWidth: "wide",
  sendKey: "enter",
  sessionSidebar: true,
  infoPanel: false,
  collapsedGroups: [],
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

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    const merged = { ...DEFAULTS, ...stored };
    // A value an older or newer build wrote that this one does not know falls back to the default.
    return {
      ...merged,
      font: valid(merged.font, UI_FONTS, DEFAULTS.font),
      codeFont: valid(merged.codeFont, CODE_FONTS, DEFAULTS.codeFont),
      textSize: valid(merged.textSize, TEXT_SCALES, DEFAULTS.textSize),
      chatWidth: valid(merged.chatWidth, CHAT_WIDTHS, DEFAULTS.chatWidth),
      collapsedGroups: Array.isArray(merged.collapsedGroups) ? merged.collapsedGroups.filter((g) => typeof g === "string") : [],
    };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const subs = new Set<() => void>();

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
  if (current.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", current.theme);
  root.style.setProperty("--font", UI_FONTS[current.font]);
  root.style.setProperty("--mono", CODE_FONTS[current.codeFont]);
  root.style.setProperty("--text-scale", String(TEXT_SCALES[current.textSize]));
  root.style.setProperty("--measure", CHAT_WIDTHS[current.chatWidth]);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

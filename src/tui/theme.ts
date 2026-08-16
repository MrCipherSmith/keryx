// TUI color themes. Semantic slots only — chrome and overlays read `getTheme()`,
// never a raw hex. Persisted in `tui.json` next to other user-global files
// (not `auth.json`: that file holds API keys).
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "../lib/config-dir";

export type ThemeId = "auto" | "groknight" | "grokday" | "tokyonight" | "keryx";
export type ThemeMode = "dark" | "light";

/** Concrete palette (never `auto`). */
export type ThemeName = Exclude<ThemeId, "auto">;

export type Theme = {
  name: ThemeName;
  bg: string;
  panel: string;
  highlight: string;
  border: string;
  text: string;
  muted: string;
  user: string;
  assistant: string;
  tool: string;
  side: string;
  focus: string;
  error: string;
  ok: string;
};

export const THEME_NAMES: readonly ThemeName[] = ["groknight", "grokday", "tokyonight", "keryx"];
export const THEME_IDS: readonly ThemeId[] = ["auto", ...THEME_NAMES];
export const DEFAULT_THEME_ID: ThemeId = "groknight";

const THEMES: Record<ThemeName, Theme> = {
  groknight: {
    name: "groknight",
    bg: "#0a0a0a",
    panel: "#141414",
    highlight: "#242424",
    border: "#414141",
    text: "#e1e1e1",
    muted: "#6c6c6c",
    user: "#c8c8c8",
    assistant: "#bb9af7",
    tool: "#787878",
    side: "#9d7cd8",
    focus: "#e0af68",
    error: "#f7768e",
    ok: "#9ece6a",
  },
  grokday: {
    name: "grokday",
    bg: "#f5f5f5",
    panel: "#eeeeee",
    highlight: "#dedede",
    border: "#b2b2b2",
    text: "#262626",
    muted: "#767676",
    user: "#444444",
    assistant: "#7d4bc6",
    tool: "#2f64d2",
    side: "#6c3eb2",
    focus: "#a27612",
    error: "#cd3048",
    ok: "#378e23",
  },
  tokyonight: {
    name: "tokyonight",
    bg: "#1a1b26",
    panel: "#24283b",
    highlight: "#292e42",
    border: "#3b4261",
    text: "#c0caf5",
    muted: "#565f89",
    user: "#a9b1d6",
    assistant: "#bb9af7",
    tool: "#7aa2f7",
    side: "#9d7cd8",
    focus: "#e0af68",
    error: "#f7768e",
    ok: "#9ece6a",
  },
  keryx: {
    name: "keryx",
    bg: "#0a1414",
    panel: "#0f1b1b",
    highlight: "#22333b",
    border: "#3a4a4a",
    text: "#c8d0d0",
    muted: "#6b7a7a",
    user: "#c8d0d0",
    assistant: "#5ec8c8",
    tool: "#5ec8c8",
    side: "#5a3a6a",
    focus: "#ffd166",
    error: "#e05a5a",
    ok: "#6bcf6b",
  },
};

export type ThemeListener = (theme: Theme, id: ThemeId) => void;

let kind: ThemeId = DEFAULT_THEME_ID;
let resolved: Theme = THEMES.groknight;
const listeners = new Set<ThemeListener>();

export function parseThemeId(raw: string): ThemeId | undefined {
  const key = raw.trim().toLowerCase();
  if (key === "auto" || key === "system") {
    return "auto";
  }
  if (key === "dark" || key === "grok-night") {
    return "groknight";
  }
  if (key === "light" || key === "day" || key === "grok-day") {
    return "grokday";
  }
  if (key === "tokyo" || key === "tokyo-night") {
    return "tokyonight";
  }
  return THEME_IDS.find((id) => id === key);
}

export function resolveTheme(id: ThemeId, mode: ThemeMode | null = null): Theme {
  if (id === "auto") {
    return mode === "light" ? THEMES.grokday : THEMES.groknight;
  }
  return THEMES[id];
}

export function getTheme(): Theme {
  return resolved;
}

export function getThemeId(): ThemeId {
  return kind;
}

export function themeLabel(id: ThemeId): string {
  switch (id) {
    case "auto":
      return "auto (follow terminal)";
    case "groknight":
      return "groknight";
    case "grokday":
      return "grokday";
    case "tokyonight":
      return "tokyonight";
    case "keryx":
      return "keryx";
  }
}

export function applyThemeId(id: ThemeId, mode: ThemeMode | null = null): Theme {
  kind = id;
  resolved = resolveTheme(id, mode);
  for (const listener of listeners) {
    listener(resolved, kind);
  }
  return resolved;
}

export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function tuiConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "tui.json");
}

export function loadPersistedThemeId(dir?: string): ThemeId {
  try {
    const file = tuiConfigPath(dir);
    if (!existsSync(file)) {
      return DEFAULT_THEME_ID;
    }
    const read = readConfigFile(file);
    if (!read.ok) {
      return DEFAULT_THEME_ID;
    }
    const raw: unknown = JSON.parse(read.text);
    if (raw === null || typeof raw !== "object") {
      return DEFAULT_THEME_ID;
    }
    const value = (raw as { theme?: unknown }).theme;
    if (typeof value !== "string") {
      return DEFAULT_THEME_ID;
    }
    return parseThemeId(value) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function persistThemeId(id: ThemeId, dir?: string): void {
  try {
    ensureKeryxConfigDir(dir);
    writeOwnerOnlyFile(tuiConfigPath(dir), `${JSON.stringify({ theme: id }, null, 2)}\n`);
  } catch {
    // best-effort
  }
}

export function formatThemeList(active: ThemeId = kind): string {
  const lines = THEME_IDS.map((id) => {
    const mark = id === active ? "*" : " ";
    return `  ${mark} ${themeLabel(id)}`;
  });
  return `Themes (/theme <name>):\n${lines.join("\n")}\n`;
}

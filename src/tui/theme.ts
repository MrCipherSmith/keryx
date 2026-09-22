// TUI color themes. Semantic slots only — chrome and overlays read `getTheme()`,
// never a raw hex. Persisted in `tui.json` next to other user-global files
// (not `auth.json`: that file holds API keys).
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "../lib/config-dir";

export type ThemeId =
  | "auto"
  | "groknight"
  | "grokday"
  | "tokyonight"
  | "keryx"
  | "midnight"
  | "nord"
  | "ember"
  | "violet"
  | "paper"
  | "frost"
  | "sand"
  | "mint";
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

/** Semantic colours used inside transcript content. */
export type TranscriptPalette = {
  prose: string;
  heading: string;
  emphasis: string;
  inlineCode: string;
  inlineCodeBackground: string;
  blockMeta: string;
  tableHeader: string;
  tableBorder: string;
  codePlain: string;
  codeComment: string;
  codeString: string;
  codeNumber: string;
  codeKeyword: string;
  diffContext: string;
  diffMeta: string;
  diffHunk: string;
  diffAdd: string;
  diffDelete: string;
  diffAddBackground: string;
  diffDeleteBackground: string;
};

/**
 * The de-emphasis axis every surface can name without knowing a palette slot.
 * OpenTUI's own named helpers (`otui.cyan`, `otui.yellow`, …) are fixed,
 * terminal-independent hexes — see `theme-text.ts` for why they are unusable —
 * so a surface asks for a ROLE and this module answers with the active theme's
 * colour for it.
 */
export type TextRole = "text" | "muted" | "accent" | "attention" | "ok" | "error" | "side";

function hexChannels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function mixHex(base: string, accent: string, accentWeight: number): string {
  const a = hexChannels(base);
  const b = hexChannels(accent);
  const channel = (index: number): string =>
    Math.round((a[index] ?? 0) * (1 - accentWeight) + (b[index] ?? 0) * accentWeight)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function relativeLuminance(hex: string): number {
  const linear = hexChannels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Pull an accent toward normal text until it is calm and readable. */
function transcriptAccent(theme: Theme, accent: string): string {
  for (let weight = 0.5; weight >= 0; weight -= 0.05) {
    const candidate = mixHex(theme.text, accent, weight);
    if (contrastRatio(candidate, theme.bg) >= 3 && contrastRatio(candidate, theme.panel) >= 3) {
      return candidate;
    }
  }
  return theme.text;
}

/** Derive transcript roles from a theme without duplicating colours in every palette. */
export function deriveTranscriptPalette(theme: Theme): TranscriptPalette {
  const heading = transcriptAccent(theme, theme.assistant);
  const muted = transcriptAccent(theme, theme.muted);
  const positive = transcriptAccent(theme, theme.ok);
  const negative = transcriptAccent(theme, theme.error);
  const focus = transcriptAccent(theme, theme.focus);
  return {
    prose: theme.text,
    heading,
    emphasis: theme.text,
    inlineCode: focus,
    inlineCodeBackground: theme.highlight,
    blockMeta: theme.muted,
    tableHeader: heading,
    tableBorder: theme.border,
    codePlain: theme.text,
    codeComment: muted,
    codeString: positive,
    codeNumber: focus,
    codeKeyword: heading,
    diffContext: theme.text,
    diffMeta: muted,
    diffHunk: heading,
    diffAdd: positive,
    diffDelete: negative,
    diffAddBackground: mixHex(theme.panel, theme.ok, 0.12),
    diffDeleteBackground: mixHex(theme.panel, theme.error, 0.12),
  };
}

/**
 * The active theme's colour for a semantic `TextRole`.
 *
 * `accent` is the `tool` slot and `attention` the `focus` slot: those are the two
 * roles the surfaces kept spelling as fixed ANSI-bright helpers (a tool call
 * marker was `otui.cyan`, a warning `otui.yellow`), and the palettes already
 * carry a deliberately softer answer for each.
 */
export function roleColor(role: TextRole, theme: Theme = getTheme()): string {
  switch (role) {
    case "text":
      return theme.text;
    case "muted":
      return theme.muted;
    case "accent":
      return theme.tool;
    case "attention":
      return theme.focus;
    case "ok":
      return theme.ok;
    case "error":
      return theme.error;
    case "side":
      return theme.side;
  }
}

export const THEME_NAMES: readonly ThemeName[] = [
  "groknight",
  "tokyonight",
  "keryx",
  "midnight",
  "nord",
  "ember",
  "violet",
  "grokday",
  "paper",
  "frost",
  "sand",
  "mint",
];
export const THEME_IDS: readonly ThemeId[] = ["auto", ...THEME_NAMES];
export const DEFAULT_THEME_ID: ThemeId = "groknight";

const LIGHT_THEME_NAMES = new Set<ThemeName>(["grokday", "paper", "frost", "sand", "mint"]);

/**
 * True for the palettes authored for a light background. One caller needs the
 * distinction rather than a colour: `dimChunk` (theme-text.ts) must pick a
 * DIFFERENT mechanism to de-emphasise with on each, because OpenTUI's DIM
 * attribute lowers luminance — which de-emphasises a light foreground on a dark
 * background and does the exact opposite for a dark one on a light background.
 */
export function isLightTheme(name: ThemeName): boolean {
  return LIGHT_THEME_NAMES.has(name);
}

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
    muted: "#737da8",
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
    side: "#b39ddb",
    focus: "#ffd166",
    error: "#e05a5a",
    ok: "#6bcf6b",
  },
  midnight: {
    name: "midnight",
    bg: "#080d18",
    panel: "#101827",
    highlight: "#17233a",
    border: "#40577a",
    text: "#dbe7ff",
    muted: "#8292ad",
    user: "#a9c7ff",
    assistant: "#8bd5ca",
    tool: "#7aa2f7",
    side: "#c6a0f6",
    focus: "#f5c26b",
    error: "#ff7a90",
    ok: "#83d17f",
  },
  nord: {
    name: "nord",
    bg: "#242933",
    panel: "#2e3440",
    highlight: "#3b4252",
    border: "#5e6b80",
    text: "#eceff4",
    muted: "#929db0",
    user: "#d8dee9",
    assistant: "#88c0d0",
    tool: "#81a1c1",
    side: "#b48ead",
    focus: "#ebcb8b",
    error: "#f0808b",
    ok: "#a3be8c",
  },
  ember: {
    name: "ember",
    bg: "#17100d",
    panel: "#211713",
    highlight: "#30201a",
    border: "#6a4d3d",
    text: "#f2e3d5",
    muted: "#a48672",
    user: "#ffd2ad",
    assistant: "#ff9f68",
    tool: "#e1b274",
    side: "#d89b72",
    focus: "#ffd166",
    error: "#ff7676",
    ok: "#a6d27a",
  },
  violet: {
    name: "violet",
    bg: "#100b1b",
    panel: "#1a1227",
    highlight: "#281b3c",
    border: "#61497d",
    text: "#eee8ff",
    muted: "#9f8db8",
    user: "#d6c4ff",
    assistant: "#c099ff",
    tool: "#76b7ff",
    side: "#ff8cc6",
    focus: "#ffd166",
    error: "#ff7699",
    ok: "#7bdba5",
  },
  paper: {
    name: "paper",
    bg: "#faf7f0",
    panel: "#f1ece1",
    highlight: "#e5ddcf",
    border: "#9d9280",
    text: "#29251f",
    muted: "#746d62",
    user: "#4b4033",
    assistant: "#6b4bbc",
    tool: "#1f62a8",
    side: "#8a4f72",
    focus: "#815500",
    error: "#b4233c",
    ok: "#2e7d32",
  },
  frost: {
    name: "frost",
    bg: "#f4f8fb",
    panel: "#eaf1f6",
    highlight: "#dbe8f0",
    border: "#93a8b7",
    text: "#1f2d3a",
    muted: "#627483",
    user: "#314c65",
    assistant: "#5b4bb7",
    tool: "#1769aa",
    side: "#794ca8",
    focus: "#805400",
    error: "#b32642",
    ok: "#2d7544",
  },
  sand: {
    name: "sand",
    bg: "#fff7e8",
    panel: "#f6ead5",
    highlight: "#ead9bb",
    border: "#ad936d",
    text: "#33291d",
    muted: "#776751",
    user: "#5b4630",
    assistant: "#744494",
    tool: "#176b75",
    side: "#91483b",
    focus: "#805400",
    error: "#b3263b",
    ok: "#347536",
  },
  mint: {
    name: "mint",
    bg: "#f2faf7",
    panel: "#e4f3ed",
    highlight: "#d3e9e0",
    border: "#8fafa3",
    text: "#19332a",
    muted: "#5d776d",
    user: "#285548",
    assistant: "#6745a6",
    tool: "#176b72",
    side: "#86506b",
    focus: "#805400",
    error: "#b32643",
    ok: "#217343",
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
    default:
      return LIGHT_THEME_NAMES.has(id) ? `${id} ☀` : id;
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

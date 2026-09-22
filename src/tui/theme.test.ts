import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import * as themeModule from "./theme";
import {
  DEFAULT_THEME_ID,
  THEME_IDS,
  THEME_NAMES,
  applyThemeId,
  formatThemeList,
  getTheme,
  getThemeId,
  loadPersistedThemeId,
  parseThemeId,
  persistThemeId,
  resolveTheme,
  roleColor,
  themeLabel,
} from "./theme";

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

type TranscriptPalette = {
  prose: string;
  heading: string;
  inlineCode: string;
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

function transcriptPalette(id: (typeof THEME_NAMES)[number]): TranscriptPalette {
  return (themeModule as unknown as {
    deriveTranscriptPalette(theme: ReturnType<typeof resolveTheme>): TranscriptPalette;
  }).deriveTranscriptPalette(resolveTheme(id));
}

test("parseThemeId accepts canonical names and aliases", () => {
  expect(parseThemeId("groknight")).toBe("groknight");
  expect(parseThemeId("dark")).toBe("groknight");
  expect(parseThemeId("tokyo-night")).toBe("tokyonight");
  expect(parseThemeId("light")).toBe("grokday");
  expect(parseThemeId("auto")).toBe("auto");
  expect(parseThemeId("midnight")).toBe("midnight");
  expect(parseThemeId("paper")).toBe("paper");
  expect(parseThemeId("nope")).toBeUndefined();
});

test("theme catalog includes eight new palettes with four new light choices", () => {
  expect(THEME_NAMES).toHaveLength(12);
  expect(new Set(THEME_NAMES).size).toBe(THEME_NAMES.length);
  expect(THEME_NAMES.slice(-4)).toEqual(["paper", "frost", "sand", "mint"]);
  expect(themeLabel("paper")).toBe("paper ☀");
  expect(themeLabel("midnight")).toBe("midnight");
});

test("every palette keeps primary text and status colors readable", () => {
  for (const id of THEME_NAMES) {
    const theme = resolveTheme(id);
    expect(contrast(theme.text, theme.bg), `${id}: text/bg`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.text, theme.panel), `${id}: text/panel`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.muted, theme.bg), `${id}: muted/bg`).toBeGreaterThanOrEqual(3);
    // `side` belongs here since the semantic-tone change: the side-worker header
    // used to be OpenTUI's fixed `otui.magenta` (#FF00FF, terminal-independent),
    // which is now the `side` SLOT — so it is held to the same floor as the other
    // accents, on both surfaces it is painted on.
    for (const slot of ["assistant", "tool", "focus", "error", "ok", "side"] as const) {
      expect(contrast(theme[slot], theme.bg), `${id}: ${slot}/bg`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme[slot], theme.panel), `${id}: ${slot}/panel`).toBeGreaterThanOrEqual(3);
    }
  }
});

test("every theme derives a deterministic semantic transcript palette", () => {
  for (const id of THEME_NAMES) {
    const first = transcriptPalette(id);
    const second = transcriptPalette(id);
    expect(first).toEqual(second);
    expect(first.prose).toBe(resolveTheme(id).text);
    expect(first.blockMeta).toBe(resolveTheme(id).muted);
    for (const color of Object.values(first)) {
      expect(color, `${id}: ${color}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  }
});

test("semantic transcript foregrounds stay readable on their actual surfaces", () => {
  const foregroundRoles: ReadonlyArray<keyof TranscriptPalette> = [
    "prose",
    "heading",
    "inlineCode",
    "tableHeader",
    "codePlain",
    "codeComment",
    "codeString",
    "codeNumber",
    "codeKeyword",
    "diffContext",
    "diffMeta",
    "diffHunk",
    "diffAdd",
    "diffDelete",
  ];
  for (const id of THEME_NAMES) {
    const theme = resolveTheme(id);
    const palette = transcriptPalette(id);
    for (const role of foregroundRoles) {
      expect(contrast(palette[role], theme.bg), `${id}: ${role}/bg`).toBeGreaterThanOrEqual(3);
      expect(contrast(palette[role], theme.panel), `${id}: ${role}/panel`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(palette.prose, theme.bg), `${id}: prose/bg`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.prose, theme.panel), `${id}: prose/panel`).toBeGreaterThanOrEqual(4.5);
  }
});

test("resolveTheme maps auto to grokday in light mode and groknight otherwise", () => {
  expect(resolveTheme("auto", "light").name).toBe("grokday");
  expect(resolveTheme("auto", "dark").name).toBe("groknight");
  expect(resolveTheme("auto", null).name).toBe("groknight");
  expect(resolveTheme("tokyonight", "light").name).toBe("tokyonight");
});

test("applyThemeId updates the live palette", () => {
  const previous = getThemeId();
  try {
    applyThemeId("keryx");
    expect(getThemeId()).toBe("keryx");
    expect(getTheme().bg).toBe("#0a1414");
    applyThemeId("groknight");
    expect(getTheme().bg).toBe("#0a0a0a");
  } finally {
    applyThemeId(previous);
  }
});

test("persist and load round-trip through tui.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-theme-"));
  try {
    expect(loadPersistedThemeId(dir)).toBe(DEFAULT_THEME_ID);
    persistThemeId("tokyonight", dir);
    expect(loadPersistedThemeId(dir)).toBe("tokyonight");
    persistThemeId("auto", dir);
    expect(loadPersistedThemeId(dir)).toBe("auto");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatThemeList marks the active theme", () => {
  const text = formatThemeList("grokday");
  expect(text).toContain("* grokday");
  expect(text).toContain("  groknight");
  expect(themeLabel("auto")).toContain("auto");
  expect(THEME_IDS).toHaveLength(13);
});

test("roleColor resolves every TextRole to a slot of the ACTIVE theme", () => {
  const previous = getThemeId();
  try {
    applyThemeId("grokday", "light");
    const light = resolveTheme("grokday");
    expect(roleColor("text")).toBe(light.text);
    expect(roleColor("muted")).toBe(light.muted);
    expect(roleColor("accent")).toBe(light.tool);
    expect(roleColor("attention")).toBe(light.focus);
    expect(roleColor("ok")).toBe(light.ok);
    expect(roleColor("error")).toBe(light.error);
    expect(roleColor("side")).toBe(light.side);
    // The property the fixed `otui.cyan`/`otui.yellow` hexes failed: every role
    // a light palette can be asked to paint is readable on that palette's bg.
    for (const role of ["text", "muted", "accent", "attention", "ok", "error", "side"] as const) {
      expect(contrast(roleColor(role), light.bg), `grokday: ${role}/bg`).toBeGreaterThanOrEqual(3);
    }
  } finally {
    applyThemeId(previous);
  }
});

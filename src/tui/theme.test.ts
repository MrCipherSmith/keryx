import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
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
    for (const slot of ["assistant", "tool", "focus", "error", "ok"] as const) {
      expect(contrast(theme[slot], theme.bg), `${id}: ${slot}/bg`).toBeGreaterThanOrEqual(3);
    }
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  DEFAULT_THEME_ID,
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

test("parseThemeId accepts canonical names and aliases", () => {
  expect(parseThemeId("groknight")).toBe("groknight");
  expect(parseThemeId("dark")).toBe("groknight");
  expect(parseThemeId("tokyo-night")).toBe("tokyonight");
  expect(parseThemeId("light")).toBe("grokday");
  expect(parseThemeId("auto")).toBe("auto");
  expect(parseThemeId("nope")).toBeUndefined();
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
});

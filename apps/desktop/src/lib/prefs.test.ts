import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHAT_MIN, fitSidePanelWidth, PALETTES, parsePrefs } from "./prefs";

describe("palette pref", () => {
  test("defaults both display modes independently", () => {
    for (const stored of [null, "{}"]) {
      expect(parsePrefs(stored).lightPalette).toBe("default");
      expect(parsePrefs(stored).darkPalette).toBe("default");
    }
  });

  test("migrates each legacy dark or black palette to the dark choice", () => {
    for (const palette of PALETTES.filter((p) => p.group !== "light")) {
      const parsed = parsePrefs(JSON.stringify({ theme: "light", palette: palette.id }));
      expect(parsed.theme).toBe("light");
      expect(parsed.lightPalette).toBe("default");
      expect(parsed.darkPalette).toBe(palette.id);
    }
  });

  test("keeps the saved light and dark choices and rejects cross-mode or unknown IDs", () => {
    const light = PALETTES.find((p) => p.group === "light")!;
    const dark = PALETTES.find((p) => p.group === "dark")!;
    expect(parsePrefs(JSON.stringify({ lightPalette: light.id, darkPalette: dark.id }))).toMatchObject({
      lightPalette: light.id, darkPalette: dark.id,
    });
    for (const id of ["neon", 3, "__proto__", dark.id]) {
      expect(parsePrefs(JSON.stringify({ lightPalette: id })).lightPalette).toBe("default");
    }
    expect(parsePrefs(JSON.stringify({ darkPalette: light.id })).darkPalette).toBe("default");
  });

  test("five dark and five black themes, black canvases are #000", () => {
    expect(PALETTES.filter((p) => p.group === "dark")).toHaveLength(5);
    const black = PALETTES.filter((p) => p.group === "black");
    expect(black).toHaveLength(5);
    for (const p of black) expect(p.canvas).toBe("#000000");
  });

  test("each mode has distinct palettes that define every color role", () => {
    const css = readFileSync(new URL("../styles/themes.css", import.meta.url), "utf8");
    const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
    const darkBlock = tokens.split(':root[data-theme="dark"] {')[1]!.split("}")[0]!;
    const roles = [...darkBlock.matchAll(/(--[\w-]+):/g)].map((m) => m[1]!);
    expect(roles.length).toBeGreaterThan(30);
    expect(PALETTES.filter((p) => p.group === "light").length).toBeGreaterThan(2);
    for (const p of PALETTES) {
      const mode = p.group === "light" ? "light" : "dark";
      const block = css.split(`:root[data-palette="${p.id}"][data-theme="${mode}"] {`)[1]!.split("}")[0]!;
      for (const role of roles) expect(block).toContain(`${role}:`);
      expect(block).toContain(`--bg-canvas: ${p.canvas};`);
      expect(block).toContain(`--accent: ${p.accent};`);
    }
  });
});

describe("fitSidePanelWidth", () => {
  test("a width stored in a larger window leaves the chat its minimum and takes at most 60% of the window", () => {
    // 1200 px wide, session sidebar 248: 1200 - 60 - 248 - 360 = 532 left for the panel.
    expect(fitSidePanelWidth(1100, 1200, 248)).toBe(532);
    expect(1200 - 60 - 248 - fitSidePanelWidth(1100, 1200, 248) >= CHAT_MIN).toBe(true);
    // Without the sidebar the 60% share binds first.
    expect(fitSidePanelWidth(1100, 1200)).toBe(720);
  });

  test("a width that fits is kept, and out-of-range values are brought into range", () => {
    expect(fitSidePanelWidth(520, 1800, 248)).toBe(520);
    expect(fitSidePanelWidth(100, 1800)).toBe(320);
    expect(fitSidePanelWidth(Number.NaN, 1800)).toBe(320);
    expect(fitSidePanelWidth(5000, 4000)).toBe(1200);
  });

  test("in a very small window the panel keeps a usable floor; no window size keeps the stored width", () => {
    expect(fitSidePanelWidth(520, 600)).toBe(240);
    expect(fitSidePanelWidth(520, 0)).toBe(520);
  });
});

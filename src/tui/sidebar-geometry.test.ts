// Flow 468 phase C (sidebar) — the geometry store, the persisted mode, the pinned
// header with its three mode buttons, and the resize behaviour.
//
// RED until `src/tui/sidebar-geometry.ts` exists and `createShellChrome` accepts a
// `sidebar: { geometry, version, asciiIcons? }` option. The module is loaded with a
// runtime `import()` inside each test (not a static import), so the file always
// loads and every test fails on its own, for the right reason: the module is missing.
//
// API this file pins (T15/T16 implement it):
//   sidebar-geometry.ts
//     type SidebarMode = "default" | "wide" | "rail"
//     SIDEBAR_MODES = ["default", "wide", "rail"]            (cycle order)
//     SIDEBAR_WIDE_WIDTH = 68, SIDEBAR_RAIL_WIDTH = 5
//     SIDEBAR_WIDE_MIN_COLUMNS = 100   (terminal width below which wide shows default)
//     createSidebarGeometry({ columns, configDir?, mode? }) -> SidebarGeometry
//       state() -> { mode /*effective*/, preferred /*stored*/, width }
//       setMode(mode) / cycle() -> new preferred mode / resize(columns)
//       subscribe(listener) -> unsubscribe        (notified only when mode or width changed)
//       setMode and cycle persist the PREFERRED mode to <configDir>/tui.json; resize never writes
//     loadPersistedSidebarMode(dir?) / persistSidebarMode(mode, dir?)   (read-merge-write, key `sidebar`)
//     sidebarModeIcon(mode, ascii?) -> one-cell string
//     sidebarTextWidth(width) -> width - 4  (border 1 + padding 3; 34 -> 30)
//   shell-chrome.ts
//     ShellChromeOptions.sidebar?: { geometry, version?, asciiIcons? }
//       -> a header row pinned above `sb-top` (ids: sb-header > sb-title + sb-mode-default|wide|rail),
//          sidebar.width follows geometry, renderer resize calls geometry.resize(renderer.width),
//          Ctrl+L cycles the mode unless a modal / dock / overlay owns the keyboard.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { displayWidth } from "../lib/live-render";
import { createShellChrome, SIDEBAR_TEXT_WIDTH, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";
import { SIDEBAR_WIDTH } from "./sidebar-metrics";

type Mode = "default" | "wide" | "rail";
interface GeometryState {
  mode: Mode;
  preferred: Mode;
  width: number;
}
interface Geometry {
  state(): GeometryState;
  setMode(mode: Mode): void;
  cycle(): Mode;
  resize(columns: number): void;
  subscribe(listener: (state: GeometryState) => void): () => void;
}
interface GeometryModule {
  SIDEBAR_MODES: readonly Mode[];
  SIDEBAR_WIDE_WIDTH: number;
  SIDEBAR_RAIL_WIDTH: number;
  SIDEBAR_WIDE_MIN_COLUMNS: number;
  createSidebarGeometry(opts: { columns: number; configDir?: string; mode?: Mode }): Geometry;
  loadPersistedSidebarMode(dir?: string): Mode;
  persistSidebarMode(mode: Mode, dir?: string): void;
  sidebarModeIcon(mode: Mode, ascii?: boolean): string;
  sidebarTextWidth(width: number): number;
}

// A variable specifier keeps `tsc` quiet while the module does not exist yet.
const GEOMETRY_MODULE = "./sidebar-geometry";
async function loadGeometry(): Promise<GeometryModule> {
  return (await import(GEOMETRY_MODULE)) as GeometryModule;
}

async function withTmpDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "keryx-sidebar-geometry-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readTuiJson(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "tui.json"), "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Geometry store (pure)
// ---------------------------------------------------------------------------

test("flow 468 AC14: default is today's 34 columns, wide is twice that capped at half the terminal, rail is a thin strip", async () => {
  const g = await loadGeometry();
  expect(g.SIDEBAR_MODES).toEqual(["default", "wide", "rail"]);
  expect(g.SIDEBAR_WIDE_WIDTH).toBe(SIDEBAR_WIDTH * 2);
  expect(g.SIDEBAR_WIDE_WIDTH).toBe(68);
  expect(g.SIDEBAR_RAIL_WIDTH).toBe(5);
  await withTmpDir(async (configDir) => {
    expect(g.createSidebarGeometry({ columns: 200, configDir, mode: "default" }).state()).toEqual({
      mode: "default",
      preferred: "default",
      width: SIDEBAR_WIDTH,
    });
    expect(g.createSidebarGeometry({ columns: 200, configDir, mode: "wide" }).state()).toEqual({
      mode: "wide",
      preferred: "wide",
      width: 68,
    });
    // Capped at half the terminal.
    expect(g.createSidebarGeometry({ columns: 120, configDir, mode: "wide" }).state().width).toBe(60);
    expect(g.createSidebarGeometry({ columns: g.SIDEBAR_WIDE_MIN_COLUMNS, configDir, mode: "wide" }).state().width).toBe(
      g.SIDEBAR_WIDE_MIN_COLUMNS / 2,
    );
    expect(g.createSidebarGeometry({ columns: 200, configDir, mode: "rail" }).state()).toEqual({
      mode: "rail",
      preferred: "rail",
      width: 5,
    });
  });
});

test("flow 468 AC14: sidebarTextWidth is the width less the border and padding, and matches today's 30 at 34", async () => {
  const g = await loadGeometry();
  expect(g.sidebarTextWidth(SIDEBAR_WIDTH)).toBe(SIDEBAR_TEXT_WIDTH);
  expect(g.sidebarTextWidth(68)).toBe(64);
});

test("flow 468 AC14: cycle walks default -> wide -> rail -> default and returns the new mode", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 200, configDir, mode: "default" });
    expect(geo.cycle()).toBe("wide");
    expect(geo.state().mode).toBe("wide");
    expect(geo.cycle()).toBe("rail");
    expect(geo.state().mode).toBe("rail");
    expect(geo.cycle()).toBe("default");
    expect(geo.state()).toEqual({ mode: "default", preferred: "default", width: SIDEBAR_WIDTH });
  });
});

test("flow 468 AC14: subscribers are told once per real change, and an unsubscribed listener hears nothing", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 200, configDir, mode: "default" });
    const seen: GeometryState[] = [];
    const off = geo.subscribe((state) => seen.push(state));
    geo.setMode("wide");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ mode: "wide", preferred: "wide", width: 68 });
    geo.setMode("wide"); // no change
    expect(seen).toHaveLength(1);
    off();
    geo.setMode("rail");
    expect(seen).toHaveLength(1);
  });
});

test("flow 468 AC14: each mode has a single-cell icon and a distinct single-cell ASCII fallback", async () => {
  const g = await loadGeometry();
  const unicode = g.SIDEBAR_MODES.map((mode) => g.sidebarModeIcon(mode));
  const ascii = g.SIDEBAR_MODES.map((mode) => g.sidebarModeIcon(mode, true));
  for (const icon of unicode) {
    expect(displayWidth(icon)).toBe(1);
  }
  for (const icon of ascii) {
    expect(icon).toMatch(/^[\x21-\x7e]$/);
  }
  expect(new Set(unicode).size).toBe(3);
  expect(new Set(ascii).size).toBe(3);
});

// ---------------------------------------------------------------------------
// Resize / threshold (AC16)
// ---------------------------------------------------------------------------

test("flow 468 AC16: a resize re-clamps wide to half the terminal and notifies", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 200, configDir, mode: "wide" });
    const seen: GeometryState[] = [];
    geo.subscribe((state) => seen.push(state));
    geo.resize(120);
    expect(geo.state()).toEqual({ mode: "wide", preferred: "wide", width: 60 });
    expect(seen).toHaveLength(1);
    geo.resize(120); // same columns, nothing to say
    expect(seen).toHaveLength(1);
  });
});

test("flow 468 AC16: wide below the width threshold shows default, keeps the preference, and returns to wide when there is room", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 200, configDir, mode: "wide" });
    geo.resize(g.SIDEBAR_WIDE_MIN_COLUMNS - 1);
    expect(geo.state()).toEqual({ mode: "default", preferred: "wide", width: SIDEBAR_WIDTH });
    geo.resize(80);
    expect(geo.state()).toEqual({ mode: "default", preferred: "wide", width: SIDEBAR_WIDTH });
    geo.resize(200);
    expect(geo.state()).toEqual({ mode: "wide", preferred: "wide", width: 68 });
  });
});

test("flow 468 AC16: rail keeps its width at any terminal width, and default never changes", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const rail = g.createSidebarGeometry({ columns: 200, configDir, mode: "rail" });
    rail.resize(80);
    expect(rail.state().width).toBe(5);
    rail.resize(300);
    expect(rail.state().width).toBe(5);
    const normal = g.createSidebarGeometry({ columns: 200, configDir, mode: "default" });
    normal.resize(80);
    expect(normal.state().width).toBe(SIDEBAR_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// Persistence in ~/.keryx/tui.json (AC15) — always a temp directory
// ---------------------------------------------------------------------------

test("flow 468 AC15: the chosen mode survives a restart through tui.json", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const first = g.createSidebarGeometry({ columns: 200, configDir });
    expect(first.state().mode).toBe("default"); // nothing saved yet
    first.setMode("wide");
    expect((await readTuiJson(configDir)).sidebar).toBe("wide");
    const restarted = g.createSidebarGeometry({ columns: 200, configDir });
    expect(restarted.state()).toEqual({ mode: "wide", preferred: "wide", width: 68 });
    restarted.cycle();
    expect(g.loadPersistedSidebarMode(configDir)).toBe("rail");
    expect(g.createSidebarGeometry({ columns: 200, configDir }).state().mode).toBe("rail");
  });
});

test("flow 468 AC15: the preferred wide mode is what is saved, not the default it falls back to on a small terminal", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 80, configDir });
    geo.setMode("wide");
    expect(geo.state().mode).toBe("default");
    expect(g.loadPersistedSidebarMode(configDir)).toBe("wide");
    geo.resize(200); // a resize never writes the file, and it still says wide
    expect(g.loadPersistedSidebarMode(configDir)).toBe("wide");
    expect(geo.state().mode).toBe("wide");
  });
});

test("flow 468 AC15: a mode change no longer erases the theme, or any other key in tui.json", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    await writeFile(
      join(configDir, "tui.json"),
      JSON.stringify({ theme: "tokyonight", future: { a: 1 } }),
      "utf8",
    );
    g.persistSidebarMode("rail", configDir);
    expect(await readTuiJson(configDir)).toEqual({ theme: "tokyonight", future: { a: 1 }, sidebar: "rail" });
    g.createSidebarGeometry({ columns: 200, configDir }).setMode("wide");
    expect(await readTuiJson(configDir)).toEqual({ theme: "tokyonight", future: { a: 1 }, sidebar: "wide" });
  });
});

test("flow 468 AC15: an unknown or corrupt value starts in default mode without an error", async () => {
  const g = await loadGeometry();
  const contents = [
    '{"sidebar":"huge"}',
    '{"sidebar":42}',
    '{"sidebar":null}',
    '{"sidebar":["wide"]}',
    '{"theme":"groknight"}',
    "{not json",
    "[]",
    "null",
    '"wide"',
    "",
  ];
  for (const content of contents) {
    await withTmpDir(async (configDir) => {
      await writeFile(join(configDir, "tui.json"), content, "utf8");
      expect(g.loadPersistedSidebarMode(configDir), content).toBe("default");
      const geo = g.createSidebarGeometry({ columns: 200, configDir });
      expect(geo.state(), content).toEqual({ mode: "default", preferred: "default", width: SIDEBAR_WIDTH });
    });
  }
  await withTmpDir(async (configDir) => {
    expect(g.loadPersistedSidebarMode(configDir)).toBe("default"); // no file at all
  });
});

test("flow 468 AC15: saving over a corrupt tui.json does not throw and leaves valid JSON holding the mode", async () => {
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    await writeFile(join(configDir, "tui.json"), "{not json", "utf8");
    expect(() => g.persistSidebarMode("wide", configDir)).not.toThrow();
    expect((await readTuiJson(configDir)).sidebar).toBe("wide");
  });
  await withTmpDir(async (parent) => {
    const configDir = join(parent, "does", "not", "exist", "yet");
    await mkdir(join(parent, "does"), { recursive: true });
    expect(() => g.persistSidebarMode("rail", configDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pinned header, buttons, shortcut and resize in the real chrome
// ---------------------------------------------------------------------------

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

const VERSION = "9.8.7";

async function mountChrome(
  otui: OtuiBundle,
  geo: Geometry,
  opts: { width?: number; height?: number; asciiIcons?: boolean } = {},
): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 140, height: opts.height ?? 40 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · chrome",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
    toastMs: 60_000,
    sidebar: { geometry: geo, version: VERSION, asciiIcons: opts.asciiIcons === true },
  } as ShellChromeOptions);
  await setup.flush();
  return {
    ...setup,
    chrome,
    destroy: () => {
      chrome.destroy();
      setup.renderer.destroy();
    },
  };
}

type Positioned = { x: number; y: number; width: number; parent: Positioned | null; id: string };

function byId(h: TestSetup, id: string): Positioned {
  const node = h.renderer.root.findDescendantById(id) as unknown as Positioned | undefined;
  if (node === undefined) {
    throw new Error(`no renderable with id ${id}`);
  }
  return node;
}

function hasAncestor(node: Positioned, id: string): boolean {
  for (let cur = node.parent; cur !== null && cur !== undefined; cur = cur.parent) {
    if (cur.id === id) return true;
  }
  return false;
}

function lineWith(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

otuiTest("flow 468 AC14: the header is pinned above the scroll area, keeps the id sb-title, and shows keryx, the version and two icon buttons", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      const title = byId(h, "sb-title");
      const top = byId(h, "sb-top");
      expect(hasAncestor(title, "sidebar")).toBe(true);
      expect(hasAncestor(title, "sb-top")).toBe(false); // not inside the scroll area
      expect(title.y).toBeLessThan(top.y);
      const frame = h.captureCharFrame();
      const headerLine = lineWith(frame, "keryx v");
      expect(headerLine).toContain(`keryx v${VERSION}`);
      // Default preferred: the pair is wide and rail; the id names the mode a click switches TO.
      for (const mode of ["wide", "rail"] as const) {
        expect(byId(h, `sb-mode-${mode}`)).toBeDefined();
        expect(headerLine).toContain(g.sidebarModeIcon(mode));
      }
      expect(headerLine).not.toContain(g.sidebarModeIcon("default"));
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC14: the header stays on screen when the sidebar content is scrolled", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo, { height: 24 });
    try {
      for (let i = 0; i < 80; i++) {
        h.chrome.sidebarTop.add(new otui.core.TextRenderable(h.renderer, { id: `row-${i}`, content: `row ${i}`, flexShrink: 0 }));
      }
      await h.flush();
      h.chrome.sidebarScroll.scrollTop = 60;
      await h.flush();
      const frame = h.captureCharFrame();
      expect(frame).toContain(`keryx v${VERSION}`);
      expect(frame).toContain("row 6");
    } finally {
      h.destroy();
    }
  });
});

function visibleButtons(h: TestSetup, g: GeometryModule): Mode[] {
  return g.SIDEBAR_MODES.filter((mode) => {
    const node = h.renderer.root.findDescendantById(`sb-mode-${mode}`) as unknown as { visible: boolean } | undefined;
    return node !== undefined && node.visible;
  });
}

otuiTest("flow 468 AC14: exactly two buttons show, the two modes the sidebar is not set to, and the pair changes after a switch", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const expected: Record<Mode, Mode[]> = { default: ["wide", "rail"], wide: ["default", "rail"], rail: ["default", "wide"] };
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      for (const mode of ["default", "wide", "rail", "default"] as const) {
        geo.setMode(mode);
        await h.flush();
        expect(visibleButtons(h, g), mode).toEqual(expected[mode]);
        if (mode !== "rail") {
          const headerLine = lineWith(h.captureCharFrame(), "keryx v");
          for (const shown of expected[mode]) expect(headerLine).toContain(g.sidebarModeIcon(shown));
          expect(headerLine).not.toContain(g.sidebarModeIcon(mode));
        }
      }
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC14: each button is its own target at least three cells wide, with a gap cell between them that is not a hit target", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      const wide = byId(h, "sb-mode-wide");
      const rail = byId(h, "sb-mode-rail");
      expect(wide.width).toBeGreaterThanOrEqual(3);
      expect(rail.width).toBeGreaterThanOrEqual(3);
      expect(rail.x - (wide.x + wide.width)).toBeGreaterThanOrEqual(1); // a blank cell that belongs to neither
      for (let x = wide.x; x < wide.x + wide.width; x++) {
        geo.setMode("default");
        await h.flush();
        await h.mockMouse.click(x, wide.y);
        await h.flush();
        expect(geo.state().mode, `x=${x}`).toBe("wide"); // every cell of the button hits it
      }
      geo.setMode("default");
      await h.flush();
      const gap = wide.x + wide.width;
      await h.mockMouse.click(gap, wide.y);
      await h.flush();
      expect(geo.state().mode).toBe("default"); // the gap changes nothing
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC14: clicking a mode button switches the mode, resizes the sidebar and saves the choice", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      const sidebar = byId(h, "sidebar");
      expect(sidebar.width).toBe(SIDEBAR_WIDTH);
      const wide = byId(h, "sb-mode-wide");
      await h.mockMouse.click(wide.x, wide.y);
      await h.flush();
      expect(geo.state().mode).toBe("wide");
      expect(sidebar.width).toBe(68);
      expect((await readTuiJson(configDir)).sidebar).toBe("wide");

      // Now the pair is default and rail.
      const rail = byId(h, "sb-mode-rail");
      await h.mockMouse.click(rail.x, rail.y);
      await h.flush();
      expect(geo.state().mode).toBe("rail");
      expect(sidebar.width).toBe(5);
      expect((await readTuiJson(configDir)).sidebar).toBe("rail");

      // Rail: the glyph keeps the id; the two buttons (default, wide) sit on separate rows.
      expect(byId(h, "sb-title")).toBeDefined();
      const expandDefault = byId(h, "sb-mode-default");
      const expandWide = byId(h, "sb-mode-wide");
      expect(expandWide.y).toBeGreaterThan(expandDefault.y);
      await h.mockMouse.click(expandDefault.x, expandDefault.y);
      await h.flush();
      expect(geo.state().mode).toBe("default");
      expect(sidebar.width).toBe(SIDEBAR_WIDTH);
      expect((await readTuiJson(configDir)).sidebar).toBe("default");
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC14: Ctrl+L cycles the modes and does not type into the composer", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      h.mockInput.pressKey("l", { ctrl: true });
      await h.flush();
      expect(geo.state().mode).toBe("wide");
      h.mockInput.pressKey("l", { ctrl: true });
      await h.flush();
      expect(geo.state().mode).toBe("rail");
      h.mockInput.pressKey("l", { ctrl: true });
      await h.flush();
      expect(geo.state().mode).toBe("default");
      expect(h.chrome.input.value).toBe("");
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC14: the shortcut does nothing while a modal, a prompt dock or another overlay owns the keyboard", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      // A modal owns the keyboard (the modal host registers itself this way).
      const releaseModal = h.chrome.addOverlaySource(() => true, { kind: "modal" });
      h.mockInput.pressKey("l", { ctrl: true });
      await h.flush();
      expect(geo.state().mode).toBe("default");
      releaseModal();

      // The composer dock (a choice or a permission prompt).
      h.chrome.dock.visible = true;
      h.mockInput.pressKey("l", { ctrl: true });
      await h.flush();
      expect(geo.state().mode).toBe("default");
      h.chrome.dock.visible = false;

      // Any other registered overlay (queue navigation, a picker).
      const releaseOverlay = h.chrome.addOverlaySource(() => true);
      h.mockInput.pressKey("l", { ctrl: true });
      await h.flush();
      expect(geo.state().mode).toBe("default");
      releaseOverlay();

      // With everything released the shortcut works again.
      h.mockInput.pressKey("l", { ctrl: true });
      await h.flush();
      expect(geo.state().mode).toBe("wide");
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC14: asciiIcons draws the ASCII fallback icons and none of the Unicode ones", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo, { asciiIcons: true });
    try {
      const headerLine = lineWith(h.captureCharFrame(), `keryx v${VERSION}`);
      for (const mode of ["wide", "rail"] as const) {
        expect(headerLine).toContain(g.sidebarModeIcon(mode, true));
        expect(headerLine).not.toContain(g.sidebarModeIcon(mode));
      }
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC16: resizing the terminal re-clamps the sidebar; wide falls back to default below the threshold and returns", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 160, configDir, mode: "wide" });
    const h = await mountChrome(otui, geo, { width: 160, height: 30 });
    try {
      const sidebar = byId(h, "sidebar");
      expect(sidebar.width).toBe(68);
      h.resize(120, 30);
      await h.flush();
      expect(geo.state().width).toBe(60);
      expect(sidebar.width).toBe(60);
      h.resize(90, 30);
      await h.flush();
      expect(geo.state()).toEqual({ mode: "default", preferred: "wide", width: SIDEBAR_WIDTH });
      expect(sidebar.width).toBe(SIDEBAR_WIDTH);
      h.resize(160, 30);
      await h.flush();
      expect(geo.state().mode).toBe("wide");
      expect(sidebar.width).toBe(68);
    } finally {
      h.destroy();
    }
  });
});

const CARDS_MODULE = "./sidebar-cards";

otuiTest("flow 468 AC16: at 80x24 in default mode the Session card, the Work card and the toast stay visible", async () => {
  const g = await loadGeometry();
  const otui = requireOtui();
  const cardsModule = (await import(CARDS_MODULE)) as {
    mountSidebarCards(
      otui: unknown,
      renderer: unknown,
      parent: unknown,
      opts: { geometry: Geometry; snapshot: () => Record<string, unknown>; onOpenCard: (cardId: string) => void },
    ): { destroy(): void };
  };
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 80, configDir, mode: "default" });
    const h = await mountChrome(otui, geo, { width: 80, height: 24 });
    const host = cardsModule.mountSidebarCards(otui.core, h.renderer, h.chrome.sidebarTop, {
      geometry: geo,
      snapshot: () => ({
        sections: {
          model: "anthropic/sonnet",
          status: "Ready",
          governance: "3 flows",
          decisions: "2 open",
          route: "routing on",
        },
        approvalsPending: 1,
        reviewsNotReady: 2,
      }),
      onOpenCard: () => {},
    });
    try {
      h.chrome.showToast("Press Ctrl+C again to exit");
      await h.flush();
      const x = byId(h, "sidebar").x;
      const frame = h.captureCharFrame().split("\n").map((row) => row.slice(x)).join("\n");
      expect(frame).toMatch(/(^|[^A-Za-z])Session(?![A-Za-z])/);
      expect(frame).toMatch(/(^|[^A-Za-z])Work(?![A-Za-z])/); // the whole word: "Workspace" does not count
      expect(frame).toContain("Press Ctrl+C again to exit");
      expect(byId(h, "sidebar").width).toBe(SIDEBAR_WIDTH);
    } finally {
      host.destroy();
      h.destroy();
    }
  });
});

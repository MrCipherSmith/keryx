import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createShellChrome, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";
import { commandsForMode } from "../commands/agent-commands";
import {
  THEME_PICKER_FOOTER,
  THEME_PREVIEW_CODE,
  THEME_PREVIEW_MARKDOWN,
  formatThemePickerRows,
  isThemeCommand,
  moveThemeSelection,
  openThemePicker,
  presentThemePicker,
} from "./theme-picker";
import { THEME_IDS, applyThemeId, getThemeId } from "./theme";

test("isThemeCommand accepts only /theme", () => {
  expect(isThemeCommand("/theme")).toBe(true);
  expect(isThemeCommand("  /theme tokyonight")).toBe(true);
  expect(isThemeCommand("/themes")).toBe(false);
  expect(isThemeCommand("/status")).toBe(false);
});

test("formatThemePickerRows marks the cursor and the applied theme", () => {
  const rows = formatThemePickerRows("grokday", "groknight");
  expect(rows.find((row) => row.includes("grokday"))?.startsWith(">")).toBe(true);
  expect(rows.find((row) => row.includes("groknight"))).toMatch(/^ \*/);
  expect(rows.join("\n")).toContain("auto (follow terminal)");
});

test("moveThemeSelection clamps at the ends", () => {
  expect(moveThemeSelection("auto", -1)).toBe("auto");
  expect(moveThemeSelection("auto", 1)).toBe("groknight");
  expect(moveThemeSelection("mint", 1)).toBe("mint");
  expect(moveThemeSelection("mint", -1)).toBe("sand");
});

test("preview sample includes markdown and a code fence body", () => {
  expect(THEME_PREVIEW_MARKDOWN).toContain("## Assistant");
  expect(THEME_PREVIEW_MARKDOWN).toContain("**without applying**");
  expect(THEME_PREVIEW_MARKDOWN).toContain("`inline code`");
  expect(THEME_PREVIEW_CODE).toContain("export function greet");
});

test("presentThemePicker opens a compact 1-tab modal and applies only on Enter", () => {
  const calls: {
    title: string;
    tabs: readonly { id: string }[];
    footer?: readonly { key: string }[];
    contentRows?: number;
  }[] = [];
  const applied: string[] = [];
  let keyHandler: ((key: { name: string; sequence: string }) => void) | undefined;
  let closed = false;
  const handle = presentThemePicker(
    (_otui, _chrome, input) => {
      calls.push(input);
      return {
        close: () => {
          closed = true;
          input.onClose?.();
        },
        setTab: () => {},
        activeTab: () => "picker",
      };
    },
    {},
    {},
    {
      current: "groknight",
      onApply: (id) => {
        applied.push(id);
      },
      onKeypress: (handler) => {
        keyHandler = handler;
        return () => {};
      },
    },
  );
  expect(handle).toBeDefined();
  expect(calls[0]?.title).toBe("/theme");
  expect(calls[0]?.tabs.map((tab) => tab.id)).toEqual(["picker"]);
  expect(calls[0]?.footer?.map((item) => item.key)).toEqual(THEME_PICKER_FOOTER.map((item) => item.key));
  expect(calls[0]?.contentRows).toBe(22);
  expect(THEME_IDS[0]).toBe("auto");

  keyHandler?.({ name: "down", sequence: "" });
  expect(applied).toEqual([]);
  expect(closed).toBe(false);

  keyHandler?.({ name: "enter", sequence: "\r" });
  expect(applied).toEqual(["tokyonight"]);
  expect(closed).toBe(true);
});

test("Esc/close without Enter does not apply the highlighted theme", () => {
  const applied: string[] = [];
  let onClose: (() => void) | undefined;
  presentThemePicker(
    (_otui, _chrome, input) => {
      onClose = input.onClose;
      return { close: () => input.onClose?.(), setTab: () => {}, activeTab: () => "picker" };
    },
    {},
    {},
    {
      current: "tokyonight",
      onApply: (id) => {
        applied.push(id);
      },
      onKeypress: (handler) => {
        handler({ name: "down", sequence: "" });
        return () => {};
      },
    },
  );
  onClose?.();
  expect(applied).toEqual([]);
});

/**
 * Structural-guard helper (docs/requirements/keryx-shell-split): concatenates
 * every non-test `.ts` source file under this module directory, recursively,
 * so a module-boundary check keeps covering the code once `tui-shell.ts` is
 * split into `src/tui/shell/*.ts` instead of breaking outright because the
 * call site it used to read moved to a different file. `exclude` names files
 * whose own identifier DEFINITIONS would make a presence check vacuous (e.g.
 * the file that defines the symbol a sibling call site is expected to use).
 */
function readTuiModuleSources(exclude: readonly string[] = []): string {
  const dir = import.meta.dir;
  const excluded = new Set(exclude);
  const collect = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
      const full = join(d, entry.name);
      if (entry.isDirectory()) return collect(full);
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
      if (excluded.has(entry.name)) return [];
      return [full];
    });
  return collect(dir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

// Structural (module-boundary), not behavioural — kept as a text audit on
// purpose (see docs/requirements/keryx-shell-split/audits-tui-other.md's
// Notes). Two independent rules live here:
//  (1) SOMEWHERE in the module — not necessarily tui-shell.ts once it's
//      split — `/theme` must dispatch to the dedicated `openThemePicker`,
//      never fall back to a generic composer `Select` titled "Theme".
//      Scanning the whole module directory (excluding theme-picker.ts, which
//      DEFINES `openThemePicker` and would make the presence check vacuous)
//      survives that split.
//  (2) `theme-picker.ts` itself must stay a `modal-host` consumer and never
//      import `@opentui/core` directly. This file is small and is not part
//      of the god-file split, so reading it directly (not via the module
//      scan) is fine.
test("structural: /theme routes through the picker (module-wide) and theme-picker.ts never forks its own overlay", () => {
  const moduleSource = readTuiModuleSources(["theme-picker.ts"]);
  expect(moduleSource).toMatch(/openThemePicker/);
  expect(moduleSource).not.toMatch(/title:\s*"Theme"/);
  const local = readFileSync(join(import.meta.dir, "theme-picker.ts"), "utf8");
  expect(local).toMatch(/from\s*["']\.\/modal-host["']/);
  expect(local).not.toMatch(/\bimport\b[^()]*?\bfrom\s*['"]@opentui\/core['"]/s);
});

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

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): NonNullable<typeof OTUI> {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

async function mountChrome(
  otui: NonNullable<typeof OTUI>,
  opts: { width?: number; height?: number; chrome?: Partial<ShellChromeOptions> } = {},
): Promise<Awaited<ReturnType<NonNullable<typeof OTUI>["testing"]["createTestRenderer"]>> & {
  chrome: ShellChrome;
  destroy: () => void;
}> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 96, height: opts.height ?? 28 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · chrome",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
    ...opts.chrome,
  });
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

otuiTest("picker paints a 1:3 list/preview split and Apply does not run until submit", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const previous = getThemeId();
  const applied: string[] = [];
  try {
    applyThemeId("groknight");
    const handle = openThemePicker(otui.core, h.chrome, {
      current: "groknight",
      mode: h.renderer.themeMode,
      renderer: h.renderer,
      onApply: (id) => {
        applied.push(id);
      },
    });
    expect(handle).toBeDefined();
    await h.flush();

    const frame = h.captureCharFrame();
    expect(frame).toContain("/theme");
    expect(frame).toContain("[ Apply ]");
    expect(frame).toContain("Preview");
    expect(frame).toContain("Assistant");
    expect(frame).toContain("export function greet");
    expect(frame.toLowerCase()).toContain("enter apply");

    const list = h.renderer.root.findDescendantById("theme-list") as { width?: number } | null;
    const preview = h.renderer.root.findDescendantById("theme-preview") as { width?: number } | null;
    expect(list).toBeDefined();
    expect(preview).toBeDefined();
    if (typeof list?.width === "number" && typeof preview?.width === "number") {
      expect(preview.width).toBeGreaterThan(list.width);
    }
    expect(getThemeId()).toBe("groknight");
    expect(applied).toEqual([]);

    handle?.close();
    expect(applied).toEqual([]);
    expect(getThemeId()).toBe("groknight");
  } finally {
    applyThemeId(previous);
    h.destroy();
  }
});

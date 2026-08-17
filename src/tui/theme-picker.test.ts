import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  expect(moveThemeSelection("keryx", 1)).toBe("keryx");
  expect(moveThemeSelection("keryx", -1)).toBe("tokyonight");
});

test("preview sample includes markdown and a code fence body", () => {
  expect(THEME_PREVIEW_MARKDOWN).toContain("## Assistant");
  expect(THEME_PREVIEW_MARKDOWN).toContain("**without applying**");
  expect(THEME_PREVIEW_MARKDOWN).toContain("`inline code`");
  expect(THEME_PREVIEW_CODE).toContain("export function greet");
});

test("presentThemePicker opens a 1-tab modal and applies only on Enter", () => {
  const calls: { title: string; tabs: readonly { id: string }[]; footer?: readonly { key: string }[] }[] = [];
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
  expect(THEME_IDS[0]).toBe("auto");

  keyHandler?.({ name: "down", sequence: "" });
  expect(applied).toEqual([]);
  expect(closed).toBe(false);

  keyHandler?.({ name: "enter", sequence: "\r" });
  expect(applied).toEqual(["grokday"]);
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

test("tui-shell routes /theme through the picker and not a composer Select", () => {
  const tui = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  expect(tui).toMatch(/openThemePicker/);
  expect(tui).not.toMatch(/title:\s*"Theme"/);
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

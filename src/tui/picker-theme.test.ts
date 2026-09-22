// The startup provider/model picker is the FIRST screen a fresh `keryx shell`
// paints, and it mounts on the bare renderer — before any chrome exists.
// Built on OpenTUI's own `SelectRenderable` defaults it carries a fixed dark
// palette (`#334455` selection, `#FFFF00` selected text, `#FFFFFF` text) on
// EVERY theme: on the light ones the selection is a dark slab under
// near-invisible text, and `/theme` cannot move it, because no chrome surface
// owns it. `selectThemeColors` is what the picker now spreads, and this test
// mounts the SHIPPED picker — never a replica — and asserts on the RENDERED
// spans: `SelectRenderable` declares setters only, so the colours it holds are
// private and reading them back would prove nothing about the frame.
import { expect, test } from "bun:test";
import type { DetectedProvider } from "../commands/select";
import { themeColorToHex } from "./shell-chrome";
import { applyThemeId, getThemeId, resolveTheme } from "./theme";
import { selectProviderModelInTui } from "./tui-shell";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    // SEQUENTIAL, never `Promise.all` — see `shell-chrome.test.ts`'s own loader
    // for the module-cycle reason (duplicated rather than imported: importing a
    // `*.test.ts` re-registers that file's whole suite).
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;

// Loaded ONCE at module scope: an absent optional dependency SKIPS these tests
// instead of passing them as no-ops (same reason as shell-chrome.test.ts).
const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

/** OpenTUI holds a lone Esc for 20ms to tell it from the start of a sequence. */
const ESC_PARSER_TIMEOUT_MS = 20;

async function pressEscapeAndSettle(h: {
  mockInput: TestSetup["mockInput"];
  flush: TestSetup["flush"];
}): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

/** The provider the picker is given; its label is what the picker paints. */
const PROVIDER: DetectedProvider = { name: "deepseek", label: "DeepSeek", models: ["deepseek-chat"] };

/** Every `#rrggbb` a captured frame painted, split by whether it was fg or bg. */
function paintedHexes(frame: {
  lines: readonly { spans: readonly { fg: unknown; bg: unknown }[] }[];
}): { fg: Set<string>; bg: Set<string> } {
  const fg = new Set<string>();
  const bg = new Set<string>();
  for (const line of frame.lines) {
    for (const span of line.spans) {
      const asFg = themeColorToHex(span.fg);
      if (asFg !== undefined) fg.add(asFg);
      const asBg = themeColorToHex(span.bg);
      if (asBg !== undefined) bg.add(asBg);
    }
  }
  return { fg, bg };
}

otuiTest("the startup picker is painted from the active palette, on a dark and a light theme", async () => {
  const otui = requireOtui();
  const previous = getThemeId();
  try {
    for (const id of ["groknight", "grokday"] as const) {
      applyThemeId(id); // before mounting: the picker paints from getTheme()
      const theme = resolveTheme(id);
      const h = await otui.testing.createTestRenderer({ width: 100, height: 30 });
      const pending = selectProviderModelInTui(otui.core, h.renderer, [PROVIDER], { env: {} });
      await h.waitForFrame((f) => f.includes("Select a provider"));
      await h.flush();

      const { fg, bg } = paintedHexes(h.captureSpans());
      // The selected row's own colours — the two OpenTUI pins, per theme.
      expect(bg.has(theme.highlight)).toBe(true);
      expect(fg.has(theme.focus)).toBe(true);
      // …and none of OpenTUI's fixed defaults survived anywhere in the frame.
      for (const fixed of ["#334455", "#ffff00", "#1a1a1a"]) {
        expect(bg.has(fixed)).toBe(false);
        expect(fg.has(fixed)).toBe(false);
      }

      // Esc cancels at the provider step: the wizard resolves nothing, and no
      // config is written on the way out.
      await pressEscapeAndSettle(h);
      expect(await pending).toBeUndefined();
      h.renderer.destroy();
    }
  } finally {
    applyThemeId(previous);
  }
});

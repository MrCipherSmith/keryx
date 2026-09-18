import { describe, expect, test } from "bun:test";
import { pickModelInTui, pickSessionInTui, type SessionSummary } from "./tui-shell";
import { createShellChrome, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";
import { commandsForMode } from "../commands/agent-commands";

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
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

const TITLE = "keryx · chrome";
const STATUS = "s/m";
const FOOTER_HINT = "/ commands";
const PLACEHOLDER = "ask keryx";

async function mountChrome(
  otui: OtuiBundle,
  opts: { width?: number; height?: number; chrome?: Partial<ShellChromeOptions> } = {},
): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 120, height: opts.height ?? 40 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: TITLE,
    status: STATUS,
    footerHint: FOOTER_HINT,
    placeholder: PLACEHOLDER,
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

describe("Flow 269: Phase 2 Pickers in ModalHost", () => {
  otuiTest("AC3: The /model picker mounts inside ModalHost preserving shell chrome, with filter and navigation", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui, { width: 120, height: 40 });

    const models = ["gpt-4o", "claude-3-5-sonnet", "deepseek-chat", "gemini-1.5-pro"];
    const resultPromise = pickModelInTui(otui.core, h.chrome, models);
    await h.flush();

    // 1. Shell chrome remains mounted
    expect(h.chrome.overlayActive()).toBe(true);
    expect(h.renderer.root.findDescendantById("header")).toBeDefined();
    expect(h.renderer.root.findDescendantById("sidebar")).toBeDefined();

    // 2. ModalHost renders backdrop and panel
    const backdrop = h.renderer.root.findDescendantById("modal-backdrop");
    const panel = h.renderer.root.findDescendantById("modal-panel");
    expect(backdrop).toBeDefined();
    expect(panel).toBeDefined();

    const frame = h.captureCharFrame();
    expect(frame).toContain("Select a model");
    expect(frame).toContain("[Models]");
    expect(frame).toContain("gpt-4o");
    expect(frame).toContain("deepseek-chat");

    // 3. Functional filter: typing 'deep' filters the select options
    await h.mockInput.pressKeys(["d", "e", "e", "p"]);
    await h.flush();

    const filteredFrame = h.captureCharFrame();
    expect(filteredFrame).toContain("deepseek-chat");
    expect(filteredFrame).toContain("filter: deep");

    // 4. Confirm selection via Enter
    h.mockInput.pressEnter();
    await h.flush();

    const chosen = await resultPromise;
    expect(chosen).toBe("deepseek-chat");

    // 5. Modal closes cleanly and focus restores
    await h.flush();
    expect(h.chrome.overlayActive()).toBe(false);
    expect(h.renderer.root.findDescendantById("modal-backdrop")?.visible).toBe(false);

    h.destroy();
  });

  otuiTest("AC4: The /sessions picker mounts inside ModalHost preserving shell chrome, with single non-duplicated footer", async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui, { width: 120, height: 40 });

    const sessions: SessionSummary[] = [
      {
        id: "sess-abc-12345678",
        title: "Fix compiler warning in parser",
        projectPath: "/projects/keryx",
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T11:00:00.000Z",
        messageCount: 8,
      },
      {
        id: "sess-def-87654321",
        title: "Implement new dashboard feature",
        projectPath: "/projects/keryx",
        createdAt: "2026-09-18T12:00:00.000Z",
        updatedAt: "2026-09-18T13:00:00.000Z",
        messageCount: 3,
      },
    ];

    const resultPromise = pickSessionInTui(otui.core, h.chrome, sessions);
    await h.flush();

    // 1. Shell chrome remains mounted
    expect(h.chrome.overlayActive()).toBe(true);
    expect(h.renderer.root.findDescendantById("header")).toBeDefined();
    expect(h.renderer.root.findDescendantById("sidebar")).toBeDefined();

    // 2. ModalHost renders backdrop and panel
    const panel = h.renderer.root.findDescendantById("modal-panel");
    expect(panel).toBeDefined();

    const frame = h.captureCharFrame();
    expect(frame).toContain("Session Switcher");
    expect(frame).toContain("[Sessions]");
    expect(frame).toContain("Fix compiler warning");
    expect(frame).toContain("Implement new dashboard");

    // 3. Single non-duplicated footer instructions
    // Header/filterline should NOT repeat "↑/↓ Enter · Esc to cancel", only footer has it
    expect(frame).toContain("↑/↓ select · Enter open · esc cancel");
    expect(frame).not.toContain("Open session ↑/↓ Enter · Esc to cancel");

    // 4. Type to filter
    await h.mockInput.pressKeys(["d", "a", "s", "h"]);
    await h.flush();

    const filteredFrame = h.captureCharFrame();
    expect(filteredFrame).toContain("Implement new dashboard");
    expect(filteredFrame).toContain("filter: dash");

    // 5. Select and confirm
    h.mockInput.pressEnter();
    await h.flush();

    const chosen = await resultPromise;
    expect(chosen).toBe("sess-def-87654321");

    // 6. Modal closes cleanly
    await h.flush();
    expect(h.chrome.overlayActive()).toBe(false);
    expect(h.renderer.root.findDescendantById("modal-backdrop")?.visible).toBe(false);

    h.destroy();
  });
});

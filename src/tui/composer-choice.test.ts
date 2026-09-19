// Regression coverage for the dock reentrancy guard: two `showComposerChoice`
// calls used to be able to stack in the same dock (e.g. `/mode` opening its
// picker while a tool-approval prompt was still pending), leaving two
// independent keypress listeners racing the same Enter/Esc and silently
// resolving the FIRST dialog with whatever it happened to have selected —
// not what the user actually answered. Concurrent approval callers enqueue;
// UI callers pass `enqueue: false` to cancel immediately.
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { showComposerChoice } from "./composer-choice";
import { createShellChrome, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";

async function loadOpenTui(): Promise<
  { core: typeof import("@opentui/core"); testing: typeof import("@opentui/core/testing") } | undefined
> {
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

async function mountChrome(
  otui: OtuiBundle,
  opts: { chrome?: Partial<ShellChromeOptions> } = {},
): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 24 });
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

otuiTest(
  "a second showComposerChoice call while the dock is already open resolves immediately to its own cancelId, fires onBusy, and never touches the dock",
  async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);

    const first = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
      title: "Allow shell command?",
      subtitle: "rm -rf build",
      cancelId: "deny",
      options: [
        { id: "once", label: "Allow once", description: "", recommended: true },
        { id: "deny", label: "Deny", description: "" },
      ],
    });
    await h.flush();
    expect(h.chrome.dock.visible).toBe(true);
    expect(h.captureCharFrame()).toContain("Allow shell command?");

    let busyCalls = 0;
    const second = await showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
      title: "Permission mode (current: default)",
      cancelId: "default",
      enqueue: false,
      options: [{ id: "auto", label: "auto", description: "" }],
      onBusy: () => {
        busyCalls += 1;
      },
    });

    // Resolved WITHOUT ever mounting: the first dialog's rows are still the
    // only thing in the dock, and the second dialog's title never rendered.
    expect(second).toBe("default");
    expect(busyCalls).toBe(1);
    await h.flush();
    expect(h.captureCharFrame()).not.toContain("Permission mode");
    expect(h.captureCharFrame()).toContain("Allow shell command?");

    // The first dialog is still live and answers to the user's real keypress
    // — not silently resolved by the second call's attempt.
    h.mockInput.pressEnter();
    await h.flush();
    expect(await first).toBe("once");
    expect(h.chrome.dock.visible).toBe(false);

    h.destroy();
  },
);

otuiTest("a second call is allowed once the first has resolved", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);

  const first = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "First",
    cancelId: "cancel",
    options: [{ id: "ok", label: "OK", description: "", recommended: true }],
  });
  await h.flush();
  h.mockInput.pressEnter();
  await h.flush();
  expect(await first).toBe("ok");
  expect(h.chrome.dock.visible).toBe(false);

  let busyCalls = 0;
  const second = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Second",
    cancelId: "cancel",
    options: [{ id: "ok2", label: "OK2", description: "", recommended: true }],
    onBusy: () => {
      busyCalls += 1;
    },
  });
  await h.flush();
  expect(h.chrome.dock.visible).toBe(true);
  expect(h.captureCharFrame()).toContain("Second");
  h.mockInput.pressEnter();
  await h.flush();
  expect(await second).toBe("ok2");
  expect(busyCalls).toBe(0);

  h.destroy();
});

otuiTest("concurrent enqueue=true calls serialize instead of stacking both menus", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);

  const first = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Spawn A?",
    cancelId: "deny",
    options: [
      { id: "allow", label: "Allow", description: "", recommended: true },
      { id: "deny", label: "Deny", description: "" },
    ],
  });
  const second = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Spawn B?",
    cancelId: "deny",
    options: [
      { id: "allow", label: "Allow", description: "", recommended: true },
      { id: "deny", label: "Deny", description: "" },
    ],
  });
  await h.flush();
  const before = h.captureCharFrame();
  expect(before).toContain("Spawn A?");
  expect(before).not.toContain("Spawn B?");

  h.mockInput.pressEnter();
  await h.flush();
  expect(await first).toBe("allow");
  await h.flush();
  const after = h.captureCharFrame();
  expect(after).toContain("Spawn B?");
  expect(after).not.toContain("Spawn A?");

  h.mockInput.pressEnter();
  await h.flush();
  expect(await second).toBe("allow");
  expect(h.chrome.dock.visible).toBe(false);

  h.destroy();
});

otuiTest("abort signal resolves cancelId and hides the dock", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const ac = new AbortController();

  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Ask?",
    cancelId: "__cancel__",
    signal: ac.signal,
    options: [
      { id: "a", label: "A", description: "", recommended: true },
      { id: "b", label: "B", description: "" },
    ],
  });
  await h.flush();
  expect(h.chrome.dock.visible).toBe(true);
  ac.abort();
  expect(await pending).toBe("__cancel__");
  expect(h.chrome.dock.visible).toBe(false);

  h.destroy();
});

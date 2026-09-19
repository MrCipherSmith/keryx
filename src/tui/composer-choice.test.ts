// Dock reentrancy: concurrent showComposerChoice must queue, not stack;
// enqueue:false cancels immediately while another choice is live.
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

otuiTest("enqueue:false while the dock is open resolves cancelId, fires onBusy, and never mounts", async () => {
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

  expect(second).toBe("default");
  expect(busyCalls).toBe(1);
  await h.flush();
  expect(h.captureCharFrame()).not.toContain("Permission mode");
  expect(h.captureCharFrame()).toContain("Allow shell command?");

  h.mockInput.pressEnter();
  await h.flush();
  expect(await first).toBe("once");
  expect(h.chrome.dock.visible).toBe(false);

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

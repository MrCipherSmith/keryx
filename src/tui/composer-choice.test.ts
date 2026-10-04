// Regression coverage for the dock reentrancy guard: two `showComposerChoice`
// calls used to be able to stack in the same dock (e.g. `/mode` opening its
// picker while a tool-approval prompt was still pending), leaving two
// independent keypress listeners racing the same Enter/Esc and silently
// resolving the FIRST dialog with whatever it happened to have selected —
// not what the user actually answered. Concurrent approval callers enqueue;
// UI callers pass `enqueue: false` to cancel immediately.
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { showComposerChoice, showComposerChoiceDetailed } from "./composer-choice";
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

otuiTest("Enter right after the menu opens is ignored; a later Enter answers", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: string | undefined;
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    acceptDelayMs: 150,
    options: [
      { id: "once", label: "Allow once", description: "", recommended: true },
      { id: "deny", label: "Deny", description: "" },
    ],
  }).then((id) => {
    settled = id;
    return id;
  });
  await h.flush();
  // The Enter that was meant to send a message the user was typing.
  h.mockInput.pressEnter();
  await h.flush();
  expect(settled).toBeUndefined();
  expect(h.chrome.dock.visible).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 200));
  h.mockInput.pressEnter();
  expect(await pending).toBe("once");
  h.destroy();
});

otuiTest("Enter while the user is still typing into the open menu is ignored; Esc never is", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: string | undefined;
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    acceptDelayMs: 150,
    options: [{ id: "once", label: "Allow once", description: "", recommended: true }],
  }).then((id) => {
    settled = id;
    return id;
  });
  await h.flush();
  await new Promise((resolve) => setTimeout(resolve, 200));
  h.mockInput.pressKey("a");
  h.mockInput.pressEnter();
  await h.flush();
  expect(settled).toBeUndefined();
  h.mockInput.pressEscape();
  expect(await pending).toBe("deny");
  h.destroy();
});

otuiTest("closed dialogs release their scroll boxes (no renderer 'selection' listener leak)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const count = (): number => (h.renderer as unknown as { listenerCount: (e: string) => number }).listenerCount("selection");
  const baseline = count();
  for (let i = 0; i < 15; i++) {
    const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
      title: `Allow shell command #${i}?`,
      // Multi-line so the scrollable subtitle (a second ScrollBox) is mounted too.
      subtitle: "echo one\necho two\necho three",
      cancelId: "deny",
      options: [
        { id: "once", label: "Allow once", description: "", recommended: true },
        { id: "deny", label: "Deny", description: "" },
      ],
    });
    await h.flush();
    h.mockInput.pressEscape();
    expect(await pending).toBe("deny");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(count()).toBe(baseline);
  h.destroy();
});

// Flow 401: the own-answer row, the text step and the reason key (AC1, AC2, AC3).
const OWN_OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one", recommended: true },
  { id: "b", label: "Option B", description: "the quick one" },
];
const ownRequest = () => ({
  title: "Which way?",
  cancelId: "__cancel__",
  options: OWN_OPTIONS,
  ownAnswer: {},
});

/** Down to the last row (the own row) and Enter: the text input is open. */
async function openOwnInput(h: Awaited<ReturnType<typeof mountChrome>>): Promise<void> {
  await h.flush();
  h.mockInput.pressArrow("down");
  h.mockInput.pressArrow("down");
  h.mockInput.pressEnter();
  await h.flush();
}

otuiTest("AC1: the last row is 'Свой ответ…', Enter on it opens a text input, Enter sends the typed text", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, ownRequest());
  await h.flush();
  expect(h.captureCharFrame()).toContain("Свой ответ…");
  await openOwnInput(h);
  expect(h.captureCharFrame()).toContain("Your own answer");
  await h.mockInput.typeText("do it the third way");
  await h.flush();
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "own", text: "do it the third way" });
  expect(h.chrome.dock.visible).toBe(false);
  h.destroy();
});

otuiTest("AC1: Esc in the text input goes back to the options; a second Esc cancels the question", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: unknown;
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, ownRequest()).then((result) => {
    settled = result;
    return result;
  });
  await openOwnInput(h);
  await h.mockInput.typeText("half a thought");
  h.mockInput.pressEscape();
  // a lone Esc is held back briefly by the key parser (it could start an escape sequence)
  await new Promise((resolve) => setTimeout(resolve, 60));
  await h.flush();
  expect(settled).toBeUndefined();
  const frame = h.captureCharFrame();
  expect(frame).toContain("Свой ответ…");
  expect(frame).toContain("Tab = pick + reason");
  expect(frame).not.toContain("Your own answer —");
  h.mockInput.pressEscape();
  expect(await pending).toEqual({ kind: "id", id: "__cancel__" });
  h.destroy();
});

otuiTest("AC2: an empty or whitespace-only text is refused and the input stays open", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: unknown;
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, ownRequest()).then((result) => {
    settled = result;
    return result;
  });
  await openOwnInput(h);
  h.mockInput.pressEnter();
  await h.mockInput.typeText("   ");
  h.mockInput.pressEnter();
  await h.flush();
  expect(settled).toBeUndefined();
  expect(h.chrome.dock.visible).toBe(true);
  expect(h.captureCharFrame()).toContain("Type something first");
  await h.mockInput.typeText("x");
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "own", text: "x" });
  h.destroy();
});

otuiTest("AC3: Tab on a highlighted option opens the same input with that option fixed, and Enter returns option plus reason", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, ownRequest());
  await h.flush();
  h.mockInput.pressArrow("down"); // Option B
  h.mockInput.pressTab();
  await h.flush();
  expect(h.captureCharFrame()).toContain('Reason for "Option B"');
  await h.mockInput.typeText("the deadline is Friday");
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "reason", id: "b", reason: "the deadline is Friday" });
  h.destroy();
});

otuiTest("a menu without ownAnswer has no own row and no Tab key (approvals and slash pickers keep their old shape)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, { title: "Allow?", cancelId: "deny", options: OWN_OPTIONS });
  await h.flush();
  expect(h.captureCharFrame()).not.toContain("Свой ответ");
  h.mockInput.pressTab();
  await h.flush();
  expect(h.captureCharFrame()).not.toContain("Reason for");
  h.mockInput.pressEnter();
  expect(await pending).toBe("a");
  h.destroy();
});

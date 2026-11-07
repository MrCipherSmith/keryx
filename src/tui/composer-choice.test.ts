// Regression coverage for the dock reentrancy guard: two `showComposerChoice`
// calls used to be able to stack in the same dock (e.g. `/mode` opening its
// picker while a tool-approval prompt was still pending), leaving two
// independent keypress listeners racing the same Enter/Esc and silently
// resolving the FIRST dialog with whatever it happened to have selected —
// not what the user actually answered. Concurrent approval callers enqueue;
// UI callers pass `enqueue: false` to cancel immediately.
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { choiceDisplayLabel, choicePasteDecision, decideChoicePaste, initialChoiceSelection, setChoicePasteSink, showComposerChoice, showComposerChoiceDetailed, type ChoiceOption } from "./composer-choice";
import { HC_PASTED_HEADER, HC_UNPARSED_HEADER, hcHistoryEcho } from "./hc-message";
import { containsNode, modalHides, openModal } from "./modal-host";
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

// Flow 400 AC2: the "(Recommended)" prefix follows `recommended`; preselection is a separate flag.
const ROWS = [
  { id: "a", label: "Alpha", description: "" },
  { id: "b", label: "Beta", description: "" },
  { id: "c", label: "Gamma", description: "" },
];

test("AC2: the prefix follows recommended, never preselected", () => {
  expect(choiceDisplayLabel({ label: "Beta", recommended: true })).toBe("(Recommended) Beta");
  expect(choiceDisplayLabel({ label: "Beta" })).toBe("Beta");
  expect(choiceDisplayLabel({ label: "Beta", recommended: false })).toBe("Beta");
});

test("AC2: arm A preselects the recommended option", () => {
  const options = ROWS.map((o) => ({ ...o, recommended: o.id === "b", preselected: o.id === "b" }));
  expect(initialChoiceSelection(options)).toBe(1);
});

test("AC2: arms B and C mark the recommendation and preselect nothing", () => {
  const options = ROWS.map((o) => ({ ...o, recommended: o.id === "b", preselected: false }));
  expect(options.map(choiceDisplayLabel)).toEqual(["Alpha", "(Recommended) Beta", "Gamma"]);
  expect(initialChoiceSelection(options)).toBe(-1);
});

test("AC2: arm D has no mark and nothing preselected", () => {
  const options = ROWS.map((o) => ({ ...o, preselected: false }));
  expect(options.map(choiceDisplayLabel)).toEqual(["Alpha", "Beta", "Gamma"]);
  expect(initialChoiceSelection(options)).toBe(-1);
});

test("AC2: a menu that never sets preselected keeps the old behaviour", () => {
  expect(initialChoiceSelection(ROWS.map((o) => ({ ...o, recommended: o.id === "c" })))).toBe(2);
  const plain: ChoiceOption[] = ROWS;
  expect(initialChoiceSelection(plain)).toBe(0);
  expect(initialChoiceSelection([])).toBe(0);
});

otuiTest("AC2: with nothing preselected Enter answers nothing; Down then Enter picks the first row", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: string | undefined;
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Pick one",
    cancelId: "none",
    acceptDelayMs: 0,
    options: [
      { id: "a", label: "Alpha", description: "", preselected: false },
      { id: "b", label: "Beta", description: "", recommended: true, preselected: false },
    ],
  }).then((id) => {
    settled = id;
    return id;
  });
  await h.flush();
  expect(h.captureCharFrame()).toContain("(Recommended) Beta");
  h.mockInput.pressEnter();
  await h.flush();
  expect(settled).toBeUndefined();
  h.mockInput.pressArrow("down");
  await h.flush();
  h.mockInput.pressEnter();
  expect(await pending).toBe("a");
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

// Keyboard hand-back. The busy-agent routing choice ("Main agent is busy") has no `input.focus()` after it,
// so a closed choice left the keyboard on its destroyed options box and every later key went nowhere. A
// closing choice now returns focus to what held it when it opened — unless something newer took it, or the
// old holder was destroyed, detached or hidden meanwhile.
const ROUTE_OPTIONS = [
  { id: "main", label: "Main queue", description: "", recommended: true },
  { id: "side", label: "Side-1", description: "" },
];
const ALLOW_DENY = [
  { id: "once", label: "Allow once", description: "", recommended: true },
  { id: "deny", label: "Deny", description: "" },
];

/** True when the renderer's focused node sits inside `root`. */
function focusInside(h: Awaited<ReturnType<typeof mountChrome>>, root: { getChildren: () => unknown[] }): boolean {
  const focused = h.renderer.currentFocusedRenderable;
  return focused !== null && containsNode(root, focused);
}

otuiTest("hand-back: the busy-agent routing choice returns a live keyboard to the composer, with no caller refocus", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  expect(h.chrome.textarea.focused).toBe(true);
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Main agent is busy",
    subtitle: "what is the build doing?",
    cancelId: "side",
    enqueue: false,
    options: ROUTE_OPTIONS,
  });
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(false); // the menu holds it while open
  h.mockInput.pressEnter();
  expect(await pending).toBe("main");
  await h.flush();
  expect(h.renderer.currentFocusedRenderable).toBe(h.chrome.textarea);
  // live, not just flagged: typed keys land in the composer
  await h.mockInput.typeText("next");
  await h.flush();
  expect(h.chrome.input.value).toBe("next");
  h.destroy();
});

otuiTest("hand-back: Esc returns the keyboard to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    options: ALLOW_DENY,
  });
  await h.flush();
  h.mockInput.pressEscape();
  expect(await pending).toBe("deny");
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("hand-back: an abort returns the keyboard even when onOpen blurred the composer (the shell approval does)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const ac = new AbortController();
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    signal: ac.signal,
    onOpen: () => h.chrome.blurComposer(),
    options: ALLOW_DENY,
  });
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(false);
  ac.abort();
  expect(await pending).toBe("deny");
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("hand-back: a click on a row returns the keyboard after the renderer's own click-to-focus", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "once",
    options: ALLOW_DENY,
  });
  await h.flush();
  const lines = h.captureCharFrame().split("\n");
  const row = lines.findIndex((line) => line.includes("Deny"));
  expect(row).toBeGreaterThanOrEqual(0);
  await h.mockMouse.click((lines[row] ?? "").indexOf("Deny"), row);
  expect(await pending).toBe("deny");
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("hand-back: clicking own answer keeps typing in the answer field", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, ownRequest());
  await h.flush();
  const lines = h.captureCharFrame().split("\n");
  const row = lines.findIndex((line) => line.includes("Свой ответ"));
  expect(row).toBeGreaterThanOrEqual(0);
  await h.mockMouse.click((lines[row] ?? "").indexOf("Свой ответ"), row);
  await h.flush();
  await h.mockInput.typeText("mouse answer");
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "own", text: "mouse answer" });
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);
  expect(h.chrome.input.value).toBe("");
  h.destroy();
});

otuiTest("hand-back: an own answer sent from the text input returns the keyboard to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, ownRequest());
  await openOwnInput(h);
  expect(h.chrome.textarea.focused).toBe(false);
  await h.mockInput.typeText("third way");
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "own", text: "third way" });
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);
  expect(h.chrome.input.value).toBe(""); // the answer went to the menu, never to the composer
  h.destroy();
});

otuiTest("hand-back: queued choices pass the keyboard along, and the last one returns it to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const first = showComposerChoice(otui.core, h.renderer, h.chrome.dock, { title: "Spawn A?", cancelId: "deny", options: ALLOW_DENY });
  const second = showComposerChoice(otui.core, h.renderer, h.chrome.dock, { title: "Spawn B?", cancelId: "deny", options: ALLOW_DENY });
  await h.flush();
  h.mockInput.pressEnter();
  expect(await first).toBe("once");
  await h.flush();
  expect(h.captureCharFrame()).toContain("Spawn B?");
  expect(focusInside(h, h.chrome.dock)).toBe(true); // B took it from the composer A handed it back to
  expect(h.chrome.textarea.focused).toBe(false);
  h.mockInput.pressEnter();
  expect(await second).toBe("once");
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("hand-back: a choice refused because the dock is busy never moves the keyboard", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const first = showComposerChoice(otui.core, h.renderer, h.chrome.dock, { title: "Allow shell command?", cancelId: "deny", options: ALLOW_DENY });
  await h.flush();
  const held = h.renderer.currentFocusedRenderable;
  expect(focusInside(h, h.chrome.dock)).toBe(true);
  const refused = await showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Main agent is busy",
    cancelId: "side",
    enqueue: false,
    options: ROUTE_OPTIONS,
  });
  expect(refused).toBe("side");
  await h.flush();
  expect(h.renderer.currentFocusedRenderable).toBe(held);
  h.mockInput.pressEnter();
  expect(await first).toBe("once");
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("hand-back: a field focused while the choice is open keeps the keyboard when the choice closes", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const field = new otui.core.InputRenderable(h.renderer, { id: "newer-field", value: "" });
  h.chrome.main.add(field);
  const ac = new AbortController();
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    signal: ac.signal,
    options: ALLOW_DENY,
  });
  await h.flush();
  field.focus(); // something newer takes the keyboard while the menu is up
  ac.abort();
  expect(await pending).toBe("deny");
  await h.flush();
  expect(h.renderer.currentFocusedRenderable).toBe(field);
  expect(h.chrome.textarea.focused).toBe(false);
  h.destroy();
});

otuiTest("hand-back: modal close preserves a surviving choice", async () => {
  const otui = requireOtui(); const h = await mountChrome(otui);
  const ac = new AbortController();
  try {
    const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
      title: "Busy?", cancelId: "deny", signal: ac.signal, options: ALLOW_DENY,
    });
    await h.flush(); const choice = h.renderer.currentFocusedRenderable;
    const modal = openModal(otui.core, h.chrome, {
      title: "Inspector", tabs: [{ id: "info", label: "Info" }], renderTab: () => {},
    });
    await h.flush(); modal?.close(); await h.flush();
    expect(h.renderer.currentFocusedRenderable === choice).toBe(true);
    expect(h.chrome.textarea.focused).toBe(false);
    ac.abort(); expect(await pending).toBe("deny"); await h.flush();
    expect(h.chrome.textarea.focused).toBe(true);
  } finally { ac.abort(); h.destroy(); }
});
otuiTest("hand-back: a modal opened over the choice keeps the keyboard; closing it returns the keyboard to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const ac = new AbortController();
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    signal: ac.signal,
    options: ALLOW_DENY,
  });
  await h.flush();
  const modal = openModal(otui.core, h.chrome, { title: "Inspector", tabs: [{ id: "info", label: "Info" }], renderTab: () => {} });
  await h.flush();
  const tabStrip = h.renderer.root.findDescendantById("modal-tab-strip") ?? null;
  expect(h.renderer.currentFocusedRenderable).toBe(tabStrip);
  ac.abort();
  expect(await pending).toBe("deny");
  await h.flush();
  expect(h.renderer.currentFocusedRenderable).toBe(tabStrip);
  expect(h.chrome.textarea.focused).toBe(false);
  modal?.close();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("hand-back: never into the composer behind an open modal, even when the choice still held the keyboard", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const ac = new AbortController();
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    signal: ac.signal,
    options: ALLOW_DENY,
  });
  await h.flush();
  const menuList = h.renderer.currentFocusedRenderable;
  expect(focusInside(h, h.chrome.dock)).toBe(true);
  const modal = openModal(otui.core, h.chrome, { title: "Inspector", tabs: [{ id: "info", label: "Info" }], renderTab: () => {} });
  await h.flush();
  menuList?.focus(); // the keyboard back on the choice while the modal is still up
  ac.abort();
  expect(await pending).toBe("deny");
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(false);
  modal?.close();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("hand-back: a choice raised over an open modal returns the keyboard to the modal, not the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const modal = openModal(otui.core, h.chrome, { title: "Inspector", tabs: [{ id: "info", label: "Info" }], renderTab: () => {} });
  await h.flush();
  const tabStrip = h.renderer.root.findDescendantById("modal-tab-strip") ?? null;
  expect(h.renderer.currentFocusedRenderable).toBe(tabStrip);
  const ac = new AbortController();
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    signal: ac.signal,
    options: ALLOW_DENY,
  });
  await h.flush();
  expect(h.renderer.currentFocusedRenderable).not.toBe(tabStrip);
  ac.abort();
  expect(await pending).toBe("deny");
  await h.flush();
  expect(h.renderer.currentFocusedRenderable).toBe(tabStrip);
  expect(h.chrome.textarea.focused).toBe(false);
  modal?.close();
  h.destroy();
});

otuiTest("hand-back: a holder destroyed, detached or hidden while the choice was open never gets the keyboard", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  type Field = InstanceType<OtuiBundle["core"]["InputRenderable"]>;
  const losses: Array<[string, (field: Field) => void]> = [
    ["destroyed", (field) => field.destroyRecursively()],
    ["detached", (field) => h.chrome.main.remove(field)],
    [
      "hidden",
      (field) => {
        field.visible = false;
      },
    ],
  ];
  for (const [how, lose] of losses) {
    const field = new otui.core.InputRenderable(h.renderer, { id: `lost-${how}`, value: "" });
    h.chrome.main.add(field);
    field.focus();
    const ac = new AbortController();
    const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
      title: `Allow (${how})?`,
      cancelId: "deny",
      signal: ac.signal,
      options: ALLOW_DENY,
    });
    await h.flush();
    lose(field);
    ac.abort();
    expect(await pending).toBe("deny");
    await h.flush();
    expect(`${how}: ${h.renderer.currentFocusedRenderable === field}`).toBe(`${how}: false`);
    expect(`${how}: ${field.focused}`).toBe(`${how}: false`);
  }
  h.destroy();
});

otuiTest("hand-back: nested choices on two docks unwind in either order without stranding the keyboard", async () => {
  const otui = requireOtui();
  for (const order of ["inner-first", "outer-first"] as const) {
    const h = await mountChrome(otui);
    const dock2 = new otui.core.BoxRenderable(h.renderer, { id: "dock-2", flexDirection: "column", visible: false });
    h.chrome.main.add(dock2);
    const outerAbort = new AbortController();
    const innerAbort = new AbortController();
    const outer = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
      title: "Outer?",
      cancelId: "deny",
      signal: outerAbort.signal,
      options: ALLOW_DENY,
    });
    await h.flush();
    const outerList = h.renderer.currentFocusedRenderable;
    expect(focusInside(h, h.chrome.dock)).toBe(true);
    const inner = showComposerChoice(otui.core, h.renderer, dock2, {
      title: "Inner?",
      cancelId: "deny",
      signal: innerAbort.signal,
      options: ALLOW_DENY,
    });
    await h.flush();
    const innerList = h.renderer.currentFocusedRenderable;
    expect(focusInside(h, dock2)).toBe(true);
    if (order === "inner-first") {
      innerAbort.abort();
      expect(await inner).toBe("deny");
      await h.flush();
      expect(h.renderer.currentFocusedRenderable).toBe(outerList); // back to the outer menu, still open
      outerAbort.abort();
      expect(await outer).toBe("deny");
    } else {
      outerAbort.abort();
      expect(await outer).toBe("deny");
      await h.flush();
      expect(h.renderer.currentFocusedRenderable).toBe(innerList); // the inner menu took it later and keeps it
      innerAbort.abort();
      expect(await inner).toBe("deny"); // its holder (the outer list) is gone: the chain reaches the composer
    }
    await h.flush();
    expect(`${order}: ${h.chrome.textarea.focused}`).toBe(`${order}: true`);
    h.destroy();
  }
});

for (const count of [1, 2, 10, 15]) {
  otuiTest(`question body viewport: ${count} lines`, async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    h.resize(100, 50);
    const answer = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
      title: "Question", acceptDelayMs: 0, body: Array.from({ length: count }, (_, i) => `QUESTION-${i}`).join("\n"),
      cancelId: "cancel", options: [{ id: "yes", label: "Yes", description: "" }],
    });
    try {
      await h.flush();
      const scroll = h.chrome.dock.getChildren().find((n) => n.id.startsWith("ch-body-scroll")) as InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
      expect(scroll).toBeDefined();
      expect(scroll.height).toBe(Math.min(count, 10));
      const initialFrame = h.captureCharFrame();
      for (let i = 0; i < Math.min(count, 10); i++) expect(initialFrame).toContain(`QUESTION-${i}`);
      scroll.scrollTo(1_000_000);
      await h.flush();
      expect(h.captureCharFrame()).toContain(`QUESTION-${count - 1}`);
      h.mockInput.pressEnter();
      expect(await answer).toBe("yes");
    } finally { h.destroy(); }
  });
}

otuiTest("question body wraps without truncation and adapts to resize", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const controller = new AbortController();
  const answer = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Question", body: "START" + "x".repeat(9000) + "TAIL", cancelId: "cancel", signal: controller.signal,
    options: [{ id: "yes", label: "Yes", description: "" }],
  });
  try {
    await h.flush();
    const scroll = h.chrome.dock.getChildren().find((n) => n.id.startsWith("ch-body-scroll")) as InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
    expect(scroll).toBeDefined();
    expect(scroll.height).toBeLessThanOrEqual(10);
    h.resize(60, 18);
    await h.flush();
    expect(scroll.height).toBeLessThan(10);
    scroll.scrollTo(1_000_000);
    await h.flush();
    expect(h.captureCharFrame()).toContain("TAIL");
    expect(h.captureCharFrame()).toContain("Yes");
    controller.abort();
    expect(await answer).toBe("cancel");
    await new Promise((r) => setTimeout(r, 10));
    expect(scroll.isDestroyed).toBe(true);
  } finally { h.destroy(); }
});


otuiTest("question body: keyboard and mouse scroll without changing the picked option", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  h.resize(100, 50);
  const answer = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Question", acceptDelayMs: 0,
    body: Array.from({ length: 40 }, (_, i) => `BODY-${i}`).join("\n"),
    cancelId: "cancel",
    options: [{ id: "a", label: "Alpha", description: "" }, { id: "b", label: "Beta", description: "" }],
  });
  try {
    await h.flush();
    const scroll = h.chrome.dock.getChildren().find((n) => n.id.startsWith("ch-body-scroll")) as InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
    h.mockInput.pressArrow("down"); // Beta
    h.mockInput.pressKey("o", { ctrl: true });
    await h.flush();
    expect(scroll.focused).toBe(true);
    h.mockInput.pressArrow("down");
    await h.flush();
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const afterArrow = scroll.scrollTop;
    h.mockInput.pressKey("\x1b[6~"); // PageDown
    await h.flush();
    expect(scroll.scrollTop).toBeGreaterThan(afterArrow);
    h.mockInput.pressKey("\x1b[5~"); // PageUp
    await h.flush();
    expect(scroll.scrollTop).toBeLessThanOrEqual(afterArrow);
    scroll.scrollTo(0);
    await h.flush();
    await h.mockMouse.scroll(scroll.x + 1, scroll.y + 1, "down");
    await h.flush();
    expect(scroll.scrollTop).toBeGreaterThan(0);
    h.mockInput.pressKey("o", { ctrl: true });
    await h.flush();
    expect(scroll.focused).toBe(false);
    h.mockInput.pressEnter();
    expect(await answer).toBe("b");
    await h.flush();
    expect(h.chrome.textarea.focused).toBe(true);
  } finally { h.destroy(); }
});

otuiTest("question body: closing destroys the scrollbox and the next question starts at the top", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  try {
    for (const mode of ["answer", "escape", "abort"] as const) {
      const controller = new AbortController();
      const answer = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
        title: "Question", acceptDelayMs: 0, signal: controller.signal,
        body: Array.from({ length: 30 }, (_, i) => `REOPEN-${i}`).join("\n"),
        cancelId: "cancel", options: [{ id: "yes", label: "Yes", description: "" }],
      });
      await h.flush();
      const scroll = h.chrome.dock.getChildren().find((n) => n.id.startsWith("ch-body-scroll")) as InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
      expect(scroll.scrollTop).toBe(0);
      expect(h.captureCharFrame()).toContain("REOPEN-0");
      scroll.scrollTo(1_000_000);
      await h.flush();
      h.mockInput.pressKey("o", { ctrl: true });
      await h.flush();
      if (mode === "answer") h.mockInput.pressEnter();
      else if (mode === "escape") h.mockInput.pressEscape();
      else controller.abort();
      expect(await answer).toBe(mode === "answer" ? "yes" : "cancel");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await h.flush();
      expect(scroll.isDestroyed).toBe(true);
      expect(h.chrome.textarea.focused).toBe(true);
    }
  } finally { h.destroy(); }
});


for (const kind of ["own", "reason"] as const) {
  otuiTest(`question body: ${kind} input survives realistic host resize`, async () => {
    const otui = requireOtui();
    const h = await mountChrome(otui);
    h.resize(100, 50);
    const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, {
      ...ownRequest(), title: "Question", acceptDelayMs: 0,
      subtitle: "Pick an option, or type your own answer · Esc cancels",
      body: Array.from({ length: 25 }, (_, i) => `HOST-${i}`).join("\n"),
    });
    try {
      await h.flush();
      const scroll = h.chrome.dock.getChildren().find((n) => n.id.startsWith("ch-body-scroll")) as InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
      h.mockInput.pressArrow("down"); // Option B
      h.resize(60, 18);
      await h.flush();
      expect(h.captureCharFrame()).toContain("Option B");
      expect(scroll.height).toBeLessThan(10);
      if (kind === "own") {
        h.mockInput.pressArrow("down");
        await h.flush();
        expect(h.captureCharFrame()).toContain("Свой ответ");
        h.mockInput.pressEnter();
      } else h.mockInput.pressTab();
      await h.flush();
      await h.mockInput.typeText("kept through resize");
      h.resize(80, 24);
      await h.flush();
      expect(h.captureCharFrame()).toContain("kept through resize");
      h.mockInput.pressEnter();
      expect(await pending).toEqual(kind === "own" ? { kind: "own", text: "kept through resize" } : { kind: "reason", id: "b", reason: "kept through resize" });
    } finally { h.destroy(); }
  });
}

otuiTest("question body: topic winner destroys mounted body and releases selection listeners", async () => {
  const { raceAskUser } = await import("./ask-user-race");
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const count = () => h.renderer.listenerCount("selection");
  const baseline = count();
  let topicAnswer!: (value: string) => void;
  const topic = new Promise<string>((resolve) => { topicAnswer = resolve; });
  try {
    const pending = raceAskUser({
      turnSignal: new AbortController().signal,
      topic: () => topic,
      dock: (signal) => showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, {
        ...ownRequest(), signal, body: "first\n".repeat(30) + "last",
      }),
    });
    await h.flush();
    const scroll = h.chrome.dock.getChildren().find((n) => n.id.startsWith("ch-body-scroll")) as InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
    expect(scroll).toBeDefined();
    topicAnswer("b");
    expect(await pending).toEqual({ from: "topic", answer: "b" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.flush();
    expect(scroll.isDestroyed).toBe(true);
    expect(count()).toBe(baseline);
    expect(h.chrome.textarea.focused).toBe(true);
  } finally { h.destroy(); }
});

otuiTest("question body reserves the actual multiline composer height", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  h.resize(80, 24);
  h.chrome.input.value = Array.from({ length: 8 }, (_, i) => `draft-${i}`).join("\n");
  const controller = new AbortController();
  const pending = showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Question", acceptDelayMs: 0, signal: controller.signal,
    body: Array.from({ length: 30 }, (_, i) => `MULTILINE-${i}`).join("\n"),
    cancelId: "cancel", options: [{ id: "yes", label: "VISIBLE-ANSWER", description: "" }],
  });
  try {
    await h.flush();
    const scroll = h.chrome.dock.getChildren().find((n) => n.id.startsWith("ch-body-scroll")) as InstanceType<OtuiBundle["core"]["ScrollBoxRenderable"]>;
    expect(h.chrome.textarea.y + h.chrome.textarea.height).toBeLessThanOrEqual(h.renderer.height);
    expect(h.captureCharFrame()).toContain("VISIBLE-ANSWER");
    scroll.scrollTo(1_000_000);
    await h.flush();
    expect(h.captureCharFrame()).toContain("MULTILINE-29");
    h.mockInput.pressEnter();
    expect(await pending).toBe("yes");
  } finally {
    controller.abort();
    h.destroy();
  }
});

const laterTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// Flow 486 L1: a paste (herdr-core types a report this way) must never answer an open dialog.
const pasteDialog = (otui: OtuiBundle, h: Awaited<ReturnType<typeof mountChrome>>, extra: Record<string, unknown> = {}) =>
  showComposerChoice(otui.core, h.renderer, h.chrome.dock, {
    title: "Allow shell command?",
    cancelId: "deny",
    acceptDelayMs: 0,
    options: [
      { id: "once", label: "Allow once", description: "", recommended: true },
      { id: "deny", label: "Deny", description: "" },
    ],
    ...extra,
  });

otuiTest("a paste into the list step goes to the sink, the next Enter is swallowed, the Enter after it approves", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text));
  let settled: string | undefined;
  const pending = pasteDialog(otui, h).then((id) => (settled = id));
  await h.flush();
  await h.mockInput.pasteBracketedText("report: two bugs");
  h.mockInput.pressEnter();
  await h.flush();
  expect(got).toEqual(["report: two bugs"]);
  expect(settled).toBeUndefined();
  expect(h.chrome.dock.visible).toBe(true);
  h.mockInput.pressEnter();
  expect(await pending).toBe("once");
  h.destroy();
});

otuiTest("a second paste keeps the dialog armed; Esc after a paste still cancels", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text));
  let settled: string | undefined;
  const pending = pasteDialog(otui, h).then((id) => (settled = id));
  await h.flush();
  await h.mockInput.pasteBracketedText("one");
  await h.mockInput.pasteBracketedText("two");
  h.mockInput.pressEnter();
  await h.flush();
  expect(got).toEqual(["one", "two"]);
  expect(settled).toBeUndefined();
  await h.mockInput.pasteBracketedText("three");
  h.mockInput.pressEscape();
  expect(await pending).toBe("deny");
  h.destroy();
});

otuiTest("a paste restarts the accept delay: an Enter inside it is ignored even after the swallowed one", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  setChoicePasteSink(h.chrome.dock, () => {});
  let settled: string | undefined;
  const pending = pasteDialog(otui, h, { acceptDelayMs: 150 }).then((id) => (settled = id));
  await h.flush();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await h.mockInput.pasteBracketedText("x");
  h.mockInput.pressEnter(); // swallowed by the armed paste
  h.mockInput.pressEnter(); // inside the restarted delay
  await h.flush();
  expect(settled).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 200));
  h.mockInput.pressEnter();
  expect(await pending).toBe("once");
  h.destroy();
});

otuiTest("without a sink the pasted text is dropped with a notice and the Enter is still swallowed", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: string | undefined;
  const pending = pasteDialog(otui, h).then((id) => (settled = id));
  await h.flush();
  await h.mockInput.pasteBracketedText("lost report");
  h.mockInput.pressEnter();
  await h.flush();
  expect(settled).toBeUndefined();
  expect(h.captureCharFrame()).toContain("Esc · paste");
  expect(h.captureCharFrame()).toContain("dropped");
  h.mockInput.pressEnter();
  expect(await pending).toBe("once");
  h.destroy();
});

otuiTest("a paste in the text step belongs to the input, not the sink", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text));
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, {
    title: "Question",
    cancelId: "cancel",
    acceptDelayMs: 0,
    ownAnswer: {},
    options: [{ id: "a", label: "Alpha", description: "" }],
  });
  await h.flush();
  h.mockInput.pressTab(); // reason step for the highlighted option
  await h.flush();
  await h.mockInput.pasteBracketedText("my pasted reason");
  await h.flush();
  expect(got).toEqual([]);
  h.mockInput.pressEnter(); // the Enter that ends the paste: swallowed
  await h.flush();
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "reason", id: "a", reason: "my pasted reason" });
  h.destroy();
});

otuiTest("after the choice closes, a paste no longer reaches the sink", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text));
  const pending = pasteDialog(otui, h);
  await h.flush();
  h.mockInput.pressEnter();
  expect(await pending).toBe("once");
  await h.flush();
  await h.mockInput.pasteBracketedText("late");
  await h.flush();
  expect(got).toEqual([]);
  h.destroy();
});

test("pasted text is framed as unknown authorship, distinct from the hc-shaped header", () => {
  expect(HC_PASTED_HEADER).not.toBe(HC_UNPARSED_HEADER);
  expect(HC_PASTED_HEADER).not.toContain("herdr-core agent message");
  expect(HC_PASTED_HEADER).toContain("not the user's words");
  expect(HC_PASTED_HEADER).toContain("unknown");
  expect(HC_PASTED_HEADER).not.toContain("while a dialog was open");
});

test("hcHistoryEcho labels a stored pasted-header frame and shows its body", () => {
  expect(hcHistoryEcho(`${HC_PASTED_HEADER}\n\nreport body`)).toEqual({ marker: "◂ unknown agent ❯", line: "report body" });
  expect(hcHistoryEcho("plain user text")).toBeUndefined();
});

otuiTest("an idle shell holds pasted text until the choice closes, then delivers it, also on Esc", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text), () => "hold");
  const pending = pasteDialog(otui, h);
  await h.flush();
  await h.mockInput.pasteBracketedText("held report");
  await h.flush();
  expect(got).toEqual([]);
  h.mockInput.pressEscape();
  expect(await pending).toBe("deny");
  await laterTask();
  expect(got).toEqual(["held report"]);
  h.destroy();
});

otuiTest("a busy shell queues pasted text at once even when the hold predicate is false", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text), () => "deliver");
  const pending = pasteDialog(otui, h);
  await h.flush();
  await h.mockInput.pasteBracketedText("now");
  expect(got).toEqual(["now"]);
  h.mockInput.pressEscape();
  await pending;
  await h.flush();
  expect(got).toEqual(["now"]);
  h.destroy();
});

otuiTest("a paste in the text step stays in the input, and the next Enter is swallowed once with a notice", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: unknown;
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, {
    title: "Question",
    cancelId: "cancel",
    acceptDelayMs: 0,
    ownAnswer: {},
    options: [{ id: "a", label: "Alpha", description: "" }],
  }).then((r) => (settled = r));
  await h.flush();
  h.mockInput.pressTab();
  await h.flush();
  await h.mockInput.pasteBracketedText("answer from hc");
  h.mockInput.pressEnter();
  await h.flush();
  expect(settled).toBeUndefined();
  expect(h.captureCharFrame()).toContain("press Enter again to send");
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "reason", id: "a", reason: "answer from hc" });
  h.destroy();
});

otuiTest("typed text in the text step is sent by the first Enter: only a paste arms the guard", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, {
    title: "Question",
    cancelId: "cancel",
    acceptDelayMs: 0,
    ownAnswer: {},
    options: [{ id: "a", label: "Alpha", description: "" }],
  });
  await h.flush();
  h.mockInput.pressTab();
  await h.flush();
  await h.mockInput.typeText("by hand");
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "reason", id: "a", reason: "by hand" });
  h.destroy();
});

otuiTest("a paste behind a modal that owns every key (a secret field) is dropped with the notice and never reaches the sink; Enter stays guarded", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text), () => choicePasteDecision(otui.core, h.renderer, h.chrome.dock, false));
  const modal = openModal(otui.core, h.chrome, {
    title: "Channels",
    tabs: [{ id: "t", label: "Token" }],
    renderTab: () => {},
    ownsKeys: () => true,
  });
  await h.flush();
  expect(modalHides(h.renderer, h.chrome.dock)).toBe(true);
  let settled: string | undefined;
  const pending = pasteDialog(otui, h).then((id) => (settled = id));
  await h.flush();
  await h.mockInput.pasteBracketedText("tok-secret-123");
  h.mockInput.pressEnter();
  await h.flush();
  expect(got).toEqual([]);
  expect(settled).toBeUndefined();
  modal?.close(); // the notice is under the modal's backdrop: nobody sees it until it closes
  await h.flush();
  expect(h.captureCharFrame()).toContain("dropped"); // "paste dropped", wrapped
  h.mockInput.pressEscape();
  await pending;
  await laterTask();
  expect(got).toEqual([]);
  h.destroy();
});

otuiTest("a paste behind a modal whose text input held the keyboard is dropped", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text), () => choicePasteDecision(otui.core, h.renderer, h.chrome.dock, true));
  let field: InstanceType<OtuiBundle["core"]["InputRenderable"]> | undefined;
  const modal = openModal(otui.core, h.chrome, {
    title: "Rename",
    tabs: [{ id: "t", label: "Name" }],
    renderTab: (_id, body) => {
      field = new otui.core.InputRenderable(h.renderer, { id: "modal-field", value: "" });
      (body as { add: (n: unknown) => void }).add(field);
      field.focus();
    },
  });
  await h.flush();
  expect(h.renderer.currentFocusedRenderable === (field as unknown)).toBe(true);
  const pending = pasteDialog(otui, h);
  await h.flush();
  await h.mockInput.pasteBracketedText("secret-looking");
  await h.flush();
  expect(got).toEqual([]);
  modal?.close();
  await h.flush();
  expect(h.captureCharFrame()).toContain("dropped"); // "paste dropped", wrapped
  h.mockInput.pressEscape();
  await pending;
  h.destroy();
});

otuiTest("a paste behind a read-only modal (/status) is not dropped: delivered when busy, held and delivered after close when idle", async () => {
  const otui = requireOtui();
  for (const busy of [true, false]) {
    const h = await mountChrome(otui);
    const got: Array<[string, boolean | undefined]> = [];
    setChoicePasteSink(h.chrome.dock, (text, afterClose) => got.push([text, afterClose]), () => choicePasteDecision(otui.core, h.renderer, h.chrome.dock, busy));
    const modal = openModal(otui.core, h.chrome, { title: "Status", tabs: [{ id: "t", label: "Status" }], renderTab: () => {} });
    await h.flush();
    expect(modalHides(h.renderer, h.chrome.dock)).toBe(true);
    const pending = pasteDialog(otui, h);
    await h.flush();
    await h.mockInput.pasteBracketedText("report from a child");
    await h.flush();
    expect(got).toEqual(busy ? [["report from a child", undefined]] : []);
    modal?.close(); // Esc closes the modal first; the dialog is answered after it
    await h.flush();
    h.mockInput.pressEscape();
    await pending;
    await laterTask();
    expect(got).toEqual([["report from a child", busy ? undefined : true]]);
    h.destroy();
  }
});

test("decideChoicePaste drops only when a modal over the dialog takes typed text", () => {
  const cases: Array<[{ modalOverDock: boolean; modalTakesText: boolean; busy: boolean }, string]> = [
    [{ modalOverDock: true, modalTakesText: true, busy: true }, "drop"],
    [{ modalOverDock: true, modalTakesText: true, busy: false }, "drop"],
    [{ modalOverDock: true, modalTakesText: false, busy: true }, "deliver"],
    [{ modalOverDock: true, modalTakesText: false, busy: false }, "hold"],
    [{ modalOverDock: false, modalTakesText: true, busy: false }, "hold"],
    [{ modalOverDock: false, modalTakesText: false, busy: true }, "deliver"],
  ];
  for (const [input, expected] of cases) expect<string>(decideChoicePaste(input)).toBe(expected);
});

otuiTest("escape sequences and control characters in a pasted report are stripped before the sink", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text));
  const pending = pasteDialog(otui, h);
  await h.flush();
  await h.mockInput.pasteBracketedText("ok \u001b[31mred\u001b[0m \u001b]0;title\u0007done\u0000\nline2");
  await h.flush();
  expect(got).toHaveLength(1);
  // exact text: pins stripAnsiSequences (CSI and OSC debris) as well as the control-character strip
  expect(got[0]).toBe("ok red done\nline2");
  h.mockInput.pressEscape();
  await pending;
  h.destroy();
});

otuiTest("line breaks in a pasted report are normalised: CRLF and a bare CR become one newline, not glued lines", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text));
  const pending = pasteDialog(otui, h);
  await h.flush();
  await h.mockInput.pasteBracketedText("one\r\ntwo\rthree");
  await h.flush();
  expect(got).toEqual(["one\ntwo\nthree"]);
  h.mockInput.pressEscape();
  await pending;
  h.destroy();
});

otuiTest("held pastes are capped by count with a stated notice, and what fit is still delivered", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text), () => "hold");
  const pending = pasteDialog(otui, h);
  await h.flush();
  for (let i = 0; i < 12; i++) await h.mockInput.pasteBracketedText(`p${i}`);
  await h.flush();
  expect(h.captureCharFrame()).toContain("too much held");
  h.mockInput.pressEscape();
  await pending;
  await laterTask();
  expect(got).toHaveLength(1);
  expect(got[0]?.split("\n")).toHaveLength(8);
  h.destroy();
});

otuiTest("held pastes are capped by size", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text), () => "hold");
  const pending = pasteDialog(otui, h);
  await h.flush();
  await h.mockInput.pasteBracketedText("a".repeat(10_000));
  await h.mockInput.pasteBracketedText("b".repeat(10_000));
  await h.flush();
  expect(h.captureCharFrame()).toContain("too much held");
  h.mockInput.pressEscape();
  await pending;
  await laterTask();
  expect(got.join("")).toBe("a".repeat(10_000));
  h.destroy();
});

otuiTest("held text is delivered after the awaiting caller has continued and the lock is released, flagged as held", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const order: string[] = [];
  const flags: Array<boolean | undefined> = [];
  setChoicePasteSink(
    h.chrome.dock,
    (_text, afterClose) => {
      order.push("sink");
      flags.push(afterClose);
    },
    () => "hold",
  );
  const pending = pasteDialog(otui, h).then((id) => {
    order.push(`caller:${id}`);
  });
  await h.flush();
  await h.mockInput.pasteBracketedText("report");
  h.mockInput.pressEscape();
  await pending;
  await laterTask();
  expect(order).toEqual(["caller:deny", "sink"]);
  expect(flags).toEqual([true]);
  h.destroy();
});

otuiTest("an Enter chained behind the swallowed one stays ignored (two hc sends in a row)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  setChoicePasteSink(h.chrome.dock, () => {});
  let settled: string | undefined;
  const pending = pasteDialog(otui, h, { acceptDelayMs: 250 }).then((id) => (settled = id));
  await h.flush();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await h.mockInput.pasteBracketedText("one");
  await h.mockInput.pasteBracketedText("two");
  await new Promise((resolve) => setTimeout(resolve, 150));
  h.mockInput.pressEnter(); // ends paste one: swallowed
  await new Promise((resolve) => setTimeout(resolve, 150));
  h.mockInput.pressEnter(); // ends paste two: 300 ms after the paste, inside the delay of the swallowed Enter
  await h.flush();
  expect(settled).toBeUndefined();
  h.mockInput.pressEscape();
  await pending;
  h.destroy();
});

/** A lone Esc is held back briefly by the key parser (it could start an escape sequence). */
const escapeAndWait = async (h: Awaited<ReturnType<typeof mountChrome>>): Promise<void> => {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await h.flush();
};

const ownDialog = (otui: OtuiBundle, h: Awaited<ReturnType<typeof mountChrome>>, acceptDelayMs = 0) =>
  showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, {
    title: "Question",
    cancelId: "cancel",
    acceptDelayMs,
    ownAnswer: {},
    options: [{ id: "a", label: "Alpha", description: "" }],
  });

otuiTest("a paste in the text step does not outlive Esc: after Tab again, typed text is sent by the first Enter", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const pending = ownDialog(otui, h);
  await h.flush();
  h.mockInput.pressTab();
  await h.flush();
  await h.mockInput.pasteBracketedText("pasted, then abandoned");
  await escapeAndWait(h);
  h.mockInput.pressTab();
  await h.flush();
  await h.mockInput.typeText("by hand");
  h.mockInput.pressEnter();
  expect(await pending).toEqual({ kind: "reason", id: "a", reason: "by hand" });
  h.destroy();
});

otuiTest("the Enter swallowed in the text step restarts the accept delay for an Enter that follows in the list", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  let settled: unknown;
  const pending = ownDialog(otui, h, 250).then((r) => (settled = r));
  await h.flush();
  await new Promise((resolve) => setTimeout(resolve, 300));
  h.mockInput.pressTab();
  await h.flush();
  await h.mockInput.pasteBracketedText("report");
  h.mockInput.pressEnter(); // swallowed in the text step
  await escapeAndWait(h); // back to the list
  h.mockInput.pressEnter(); // a chained Enter, inside the restarted delay: answers nothing
  await h.flush();
  expect(settled).toBeUndefined();
  h.mockInput.pressEscape();
  expect(await pending).toEqual({ kind: "id", id: "cancel" });
  h.destroy();
});

otuiTest("held text waits for a choice queued right behind, and is delivered once after the last one closes", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: Array<[string, boolean | undefined]> = [];
  setChoicePasteSink(h.chrome.dock, (text, afterClose) => got.push([text, afterClose]), () => "hold");
  const first = pasteDialog(otui, h);
  const second = pasteDialog(otui, h); // waits on the dock lock
  await h.flush();
  await h.mockInput.pasteBracketedText("held report");
  h.mockInput.pressEscape();
  await first;
  await laterTask();
  expect(h.chrome.dock.visible).toBe(true); // the second choice has the dock
  expect(got).toEqual([]); // no turn under an open picker
  h.mockInput.pressEscape();
  await second;
  await laterTask();
  expect(got).toEqual([["held report", true]]);
  h.destroy();
});

otuiTest("held text is not delivered after the sink was removed at shutdown", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const got: string[] = [];
  setChoicePasteSink(h.chrome.dock, (text) => got.push(text), () => "hold");
  const pending = pasteDialog(otui, h);
  await h.flush();
  await h.mockInput.pasteBracketedText("late report");
  h.mockInput.pressEscape();
  await pending;
  setChoicePasteSink(h.chrome.dock, undefined);
  await laterTask();
  expect(got).toEqual([]);
  h.destroy();
});

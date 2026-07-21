// Flow 112 — T2. The first headless mount test of the shell's OWN chrome.
//
// `launchTuiAgentShell` is 1610 lines, has one caller and zero tests, and ~900
// of those lines are about to be lifted into `src/tui/shell-chrome.ts` (plan
// S1). These tests are that refactor's only safety net, so — unlike
// `mountBlockHarness` in `tui-shell.test.ts`, which builds a REPLICA layout —
// every test below mounts the shipped `createShellChrome` factory and asserts on
// captured frames.
//
// They fail until T3 lands `./shell-chrome`.
//
// `@opentui/core` is reached ONLY structurally, via `loadOpenTui`'s inferred
// return type: the chrome takes `otui` as a parameter and never imports the
// package at module top level. The optional-dependency guard in
// `src/capability/no-optional-imports` is a regex over file TEXT, so the
// forbidden import form must not be spelled out in a comment here either.
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { createShellChrome, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    // SEQUENTIAL, never `Promise.all`: the two entrypoints share a module cycle
    // (`core-slot.ts` extends `Renderable`), and evaluating them concurrently
    // hits the cycle mid-initialization — `Cannot access 'Renderable' before
    // initialization` / `… 'TestWriteStream' …`. Awaiting core first settles it.
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;

/**
 * Loaded ONCE, at module scope, so an absent optional dependency SKIPS these
 * tests instead of passing them. Each test used to `return` early, which bun
 * reports as a pass — the refactor's only safety net could evaporate into green
 * no-ops without anyone noticing.
 */
const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

/** The bundle, inside a body that only runs when it is present. */
function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

/**
 * OpenTUI's stdin parser holds a lone `\x1b` in its pending buffer for
 * `DEFAULT_TIMEOUT_MS` (20ms on the real clock) to tell a bare Esc apart from the
 * START of an escape sequence. `flush()` only awaits a render frame, not wall
 * time, so `pressEscape()` + `flush()` observes nothing at all. Real terminals
 * pay exactly the same 20ms — a harness timing accommodation, not a workaround.
 * (Duplicated from `tui-shell.test.ts` rather than extracted: importing across
 * two `*.test.ts` files would re-register that file's 68 tests.)
 */
const ESC_PARSER_TIMEOUT_MS = 20;

async function pressEscapeAndSettle(h: {
  mockInput: TestSetup["mockInput"];
  flush: TestSetup["flush"];
}): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

/** The rendered lines, trailing blank rows dropped. */
function nonEmptyLines(frame: string): string[] {
  const lines = frame.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The rendered line containing `needle`, or "". */
function lineWith(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

// Short chrome labels: the sidebar is a fixed 30 columns, so `main` is only 30
// wide at the narrowest terminal the resize sweep visits. Long labels would clip
// and the assertions would be measuring truncation instead of layout.
const TITLE = "keryx · chrome";
const STATUS = "s/m";
const FOOTER_HINT = "/ commands";
const PLACEHOLDER = "ask keryx";
/** Toast auto-clear window; the product default (5s) is unusable in a test. */
const TOAST_MS = 40;

async function mountChrome(
  otui: OtuiBundle,
  opts: { width?: number; height?: number; chrome?: Partial<ShellChromeOptions> } = {},
): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 90, height: opts.height ?? 24 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: TITLE,
    status: STATUS,
    footerHint: FOOTER_HINT,
    placeholder: PLACEHOLDER,
    commands: commandsForMode("agent"),
    toastMs: TOAST_MS,
    ...opts.chrome,
  });
  await setup.flush();
  return {
    ...setup,
    chrome,
    destroy: () => {
      chrome.destroy(); // clears the spinner/toast timers; a live interval outlives the test
      setup.renderer.destroy();
    },
  };
}

otuiTest("AC1: mounting the chrome renders header, transcript, composer and footer, with the composer focused", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 20 });

  // The transcript handle is the real scrollbox content the IO renders into.
  h.chrome.transcript.add(new otui.core.TextRenderable(h.renderer, { id: "t1", content: "transcript line one" }));
  await h.flush();
  const frame = h.captureCharFrame();
  const lines = nonEmptyLines(frame);

  expect(frame).toContain(TITLE); // header bar
  expect(frame).toContain("transcript line one"); // transcript
  expect(frame).toContain(PLACEHOLDER); // composer placeholder
  expect(frame).toContain(FOOTER_HINT); // footer

  // Ordering, not mere presence: header above the transcript, transcript above
  // the composer, footer last. A pile of detached renderables would pass a
  // `toContain` sweep and fail this.
  const rowOf = (needle: string): number => lines.findIndex((line) => line.includes(needle));
  expect(rowOf(TITLE)).toBeGreaterThanOrEqual(0);
  expect(rowOf("transcript line one")).toBeGreaterThan(rowOf(TITLE));
  expect(rowOf(PLACEHOLDER)).toBeGreaterThan(rowOf("transcript line one"));
  expect(lines[lines.length - 1]).toContain(FOOTER_HINT);
  expect(lines[lines.length - 2]?.startsWith("╰")).toBe(true); // bordered composer, bottom row
  expect(lines[lines.length - 4]?.startsWith("╭")).toBe(true); // …and top row

  // The `/`-menu starts closed; the sidebar is mounted and carries the chrome's
  // right-hand column (its left border runs the full height).
  expect(h.chrome.menu.visible).toBe(false);
  expect(h.chrome.menuActive()).toBe(false);
  expect(lineWith(frame, TITLE)).toContain("│"); // sidebar border on the header row

  // The composer holds focus from mount, and is the live composer: typed keys
  // land in it and are readable through the input adapter.
  expect(h.chrome.textarea.focused).toBe(true);
  await h.mockInput.pressKeys(["h", "i"]);
  await h.flush();
  expect(h.chrome.input.value).toBe("hi");
  expect(h.captureCharFrame()).toContain("hi");

  // …and `focusComposer()` brings focus back after something else takes it.
  h.chrome.menu.focus();
  expect(h.chrome.textarea.focused).toBe(false);
  h.chrome.focusComposer();
  expect(h.chrome.textarea.focused).toBe(true);
  h.destroy();
});

otuiTest("AC2: showToast and the busy status are live at mount, not placeholder no-ops rebound later", async () => {
  const otui = requireOtui();
  // The pre-extraction closure assigned `showToast` / `setBusyPhase` as no-ops
  // and rebound them 100-400 lines later; anything firing in between was
  // silently dropped. Here both are the FIRST calls after mount.
  const h = await mountChrome(otui, { width: 90, height: 20 });
  h.chrome.showToast("Copied to clipboard");
  h.chrome.startBusy("waiting for model");
  h.chrome.setBusyPhase("thinking");
  await h.flush();

  const frame = h.captureCharFrame();
  expect(frame).toContain("Copied to clipboard"); // the toast was NOT swallowed
  expect(nonEmptyLines(frame)[nonEmptyLines(frame).length - 1]).toContain("thinking"); // nor the phase
  h.destroy();
});

otuiTest("AC3: `/` opens the menu, printable keys filter it, Esc closes it and returns focus to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 20 });
  expect(h.chrome.menu.visible).toBe(false);

  // `/` alone opens the dropdown with the whole registry, and the dropdown —
  // not the composer — owns the keyboard from that moment.
  await h.mockInput.pressKeys(["/"]);
  await h.flush();
  expect(h.chrome.menu.visible).toBe(true);
  expect(h.chrome.menuActive()).toBe(true);
  expect(h.chrome.textarea.focused).toBe(false);
  const opened = h.captureCharFrame();
  expect(opened).toContain("/help");
  // `/model` is the second entry: on screen when unfiltered, gone once filtered.
  // (`/clear` is further down than the menu's visible window — a described
  // option costs two rows — so it is not a usable frame marker.)
  expect(opened).toContain("/model");
  expect(h.chrome.menu.options.length).toBe(commandsForMode("agent").length);

  // A printable key is re-routed back into the composer value so typing still
  // filters live, even though the composer is not the focused renderable.
  await h.mockInput.pressKeys(["h"]);
  await h.flush();
  expect(h.chrome.input.value).toBe("/h");
  const filtered = h.captureCharFrame();
  expect(filtered).toContain("/help");
  expect(filtered).not.toContain("/model"); // filtered out by the `h` prefix
  expect(h.chrome.menu.options.length).toBe(1);
  expect(h.chrome.menu.visible).toBe(true);

  // Backspace widens the filter again.
  await h.mockInput.pressKeys(["\x7f"]);
  await h.flush();
  expect(h.chrome.input.value).toBe("/");
  expect(h.captureCharFrame()).toContain("/model");
  expect(h.chrome.menu.options.length).toBe(commandsForMode("agent").length);

  // Esc closes the menu, clears the query and hands the keyboard back.
  await pressEscapeAndSettle(h);
  expect(h.chrome.menu.visible).toBe(false);
  expect(h.chrome.menuActive()).toBe(false);
  expect(h.chrome.textarea.focused).toBe(true);
  expect(h.chrome.input.value).toBe("");
  expect(h.captureCharFrame()).not.toContain("/help");

  // The composer is genuinely usable again afterwards.
  await h.mockInput.pressKeys(["o", "k"]);
  await h.flush();
  expect(h.chrome.input.value).toBe("ok");
  h.destroy();
});

otuiTest("hideMenu: dropping the dropdown for an overlay keeps the draft and re-arms a FOCUSED reopen", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 20 });

  // The user typed a `/…` query, then an approval dock / ask_user / resume
  // picker needs the screen. Those callers used to write `chrome.menu.visible =
  // false` directly, which left the private `menuNav` true.
  await h.mockInput.pressKeys(["/"]);
  await h.flush();
  expect(h.chrome.menuActive()).toBe(true);

  h.chrome.hideMenu();
  await h.flush();
  expect(h.chrome.menu.visible).toBe(false);
  expect(h.chrome.menuActive()).toBe(false);
  expect(h.chrome.input.value).toBe("/"); // unlike closeMenu, the draft survives

  // The dock closes and hands focus back (every one of those call sites does).
  h.chrome.focusComposer();
  await h.flush();
  expect(h.chrome.textarea.focused).toBe(true);

  // The next keystroke must reopen a menu that OWNS THE KEYBOARD. With `menuNav`
  // left stuck true, `refilter` skips its `menu.focus()` and the dropdown comes
  // back visible but unfocused — ↑/↓/Enter would go to the composer behind it.
  await h.mockInput.pressKeys(["h"]);
  await h.flush();
  expect(h.chrome.input.value).toBe("/h");
  expect(h.chrome.menu.visible).toBe(true);
  expect(h.chrome.menuActive()).toBe(true);
  expect(h.chrome.menu.focused).toBe(true);
  expect(h.chrome.textarea.focused).toBe(false);
  h.destroy();
});

otuiTest("AC3: an active overlay suppresses the `/`-menu key router", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 20 });
  await h.mockInput.pressKeys(["/"]);
  await h.flush();
  expect(h.chrome.menu.visible).toBe(true);
  expect(h.chrome.overlayActive()).toBe(false);

  // An overlay owns the keyboard (a picker, an approval dock): printable keys
  // must not be swallowed into the menu's filter query behind it.
  let overlayUp = false;
  const release = h.chrome.addOverlaySource(() => overlayUp);
  overlayUp = true;
  expect(h.chrome.overlayActive()).toBe(true);

  await h.mockInput.pressKeys(["h"]);
  await h.flush();
  expect(h.chrome.input.value).toBe("/"); // NOT "/h" — the router stayed out of it
  expect(h.captureCharFrame()).toContain("/model"); // …so the menu never refiltered
  expect(h.chrome.menu.options.length).toBe(commandsForMode("agent").length);

  // Same for Esc: the overlay, not the menu, decides what Esc means.
  await pressEscapeAndSettle(h);
  expect(h.chrome.menu.visible).toBe(true);

  // Dropping the overlay re-arms the router — the suppression is the overlay's,
  // not a menu that stopped working.
  overlayUp = false;
  expect(h.chrome.overlayActive()).toBe(false);
  await h.mockInput.pressKeys(["h"]);
  await h.flush();
  expect(h.chrome.input.value).toBe("/h");
  expect(h.captureCharFrame()).not.toContain("/model");

  // `withOverlay` is the same guard for the duration of an async run …
  const seen: boolean[] = [];
  await h.chrome.withOverlay(async () => {
    seen.push(h.chrome.overlayActive());
    await h.mockInput.pressKeys(["e"]);
    await h.flush();
  });
  expect(seen).toEqual([true]);
  expect(h.chrome.input.value).toBe("/h"); // the key never reached the filter
  expect(h.chrome.overlayActive()).toBe(false); // …and the depth unwound

  // Releasing the registered source removes it for good.
  overlayUp = true;
  release();
  expect(h.chrome.overlayActive()).toBe(false);
  h.destroy();
});

otuiTest("AC4: showToast renders and auto-clears", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 20, chrome: { toastMs: TOAST_MS } });
  h.chrome.showToast("Copied to clipboard");
  await h.flush();
  expect(h.captureCharFrame()).toContain("Copied to clipboard");

  // A second toast replaces the first rather than queueing behind it.
  h.chrome.showToast("Session saved");
  await h.flush();
  const replaced = h.captureCharFrame();
  expect(replaced).toContain("Session saved");
  expect(replaced).not.toContain("Copied to clipboard");

  // …and it clears itself after `toastMs`.
  await new Promise((resolve) => setTimeout(resolve, TOAST_MS * 4));
  await h.flush();
  expect(h.captureCharFrame()).not.toContain("Session saved");

  // The rest of the chrome is untouched by the toast's expiry.
  expect(h.captureCharFrame()).toContain(FOOTER_HINT);
  h.destroy();
});

otuiTest("AC4: setBusyPhase is reflected in the footer, and stopBusy restores the idle hint", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 20 });
  const footerRow = (): string => {
    const lines = nonEmptyLines(h.captureCharFrame());
    return lines[lines.length - 1] ?? "";
  };
  // Idle: the hint, and the status label on the right of the same row.
  expect(footerRow()).toContain(FOOTER_HINT);
  expect(footerRow()).toContain(STATUS);

  h.chrome.startBusy("waiting for model");
  await h.flush();
  // Asserted on the FOOTER row specifically (it carries the status label), not
  // on the frame at large — `startBusy` also writes an in-transcript status line.
  expect(footerRow()).toContain("waiting for model");
  expect(footerRow()).toContain(STATUS);
  expect(footerRow()).not.toContain(FOOTER_HINT);

  h.chrome.setBusyPhase("running read_file");
  await h.flush();
  expect(footerRow()).toContain("running read_file");
  expect(footerRow()).not.toContain("waiting for model");

  h.chrome.setBusyPhase("thinking");
  await h.flush();
  expect(footerRow()).toContain("thinking");

  h.chrome.stopBusy();
  await h.flush();
  expect(footerRow()).toContain(FOOTER_HINT);
  expect(footerRow()).not.toContain("thinking");

  // Idle `setBusyPhase` does not paint a phase over the idle hint.
  h.chrome.setBusyPhase("waiting for model");
  await h.flush();
  expect(footerRow()).toContain(FOOTER_HINT);
  h.destroy();
});

otuiTest("AC5: resize keeps the composer and footer on screen at four terminal sizes (flow-075 guard)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 24 });
  // Enough transcript to overflow every viewport below. Deliberately PLAIN text
  // renderables: the pinned upstream defect (a BORDERED child in a ScrollBox at
  // `scrollTop === 2` overdraws the row beneath it, `tui-shell.test.ts`) needs a
  // bordered child, so nothing here can accidentally depend on it.
  for (let i = 0; i < 60; i++) {
    h.chrome.transcript.add(new otui.core.TextRenderable(h.renderer, { id: `f${i}`, content: `payload line ${i}` }));
  }
  h.chrome.input.value = "draft prompt";
  await h.flush();
  expect(h.captureCharFrame()).toContain("payload line 59"); // the transcript really did fill

  for (const [width, height] of [
    [90, 24],
    [70, 18],
    [120, 30],
    [60, 12],
  ] as const) {
    h.resize(width, height);
    await h.flush();
    const at = `${width}x${height}`;
    const frame = h.captureCharFrame();
    const lines = nonEmptyLines(frame);

    // A full transcript must not shove the chrome out of the viewport: the
    // footer is the last row and the composer's rounded box owns exactly the
    // three rows directly above it.
    expect(`${at}: ${lines[lines.length - 1]?.includes(FOOTER_HINT)}`).toBe(`${at}: true`);
    expect(`${at}: ${lines[lines.length - 2]?.startsWith("╰")}`).toBe(`${at}: true`);
    expect(`${at}: ${lines[lines.length - 4]?.startsWith("╭")}`).toBe(`${at}: true`);
    // The draft survives every resize and stays rendered.
    expect(`${at}: ${h.chrome.input.value}`).toBe(`${at}: draft prompt`);
    expect(`${at}: ${frame.includes("draft prompt")}`).toBe(`${at}: true`);
    // The composer still holds focus and still accepts keys after the resize.
    expect(`${at}: ${h.chrome.textarea.focused}`).toBe(`${at}: true`);
  }
  h.destroy();
});

otuiTest("AC1: composer submissions and `/`-menu selections both reach the submit hook", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 20 });
  const submitted: string[] = [];
  h.chrome.onSubmit((line) => {
    submitted.push(line);
  });

  // Enter in the composer submits the trimmed line and clears the composer.
  h.chrome.input.value = "  where am I?  ";
  await h.flush();
  h.mockInput.pressEnter();
  await h.flush();
  expect(submitted).toEqual(["where am I?"]);
  expect(h.chrome.input.value).toBe("");

  // Selecting a command from the `/` dropdown runs it through the same hook and
  // hands focus back to the composer.
  await h.mockInput.pressKeys(["/", "h"]);
  await h.flush();
  expect(h.chrome.menu.visible).toBe(true);
  h.mockInput.pressEnter();
  await h.flush();
  expect(submitted).toEqual(["where am I?", "/help"]);
  expect(h.chrome.menu.visible).toBe(false);
  expect(h.chrome.textarea.focused).toBe(true);
  expect(h.chrome.input.value).toBe("");
  h.destroy();
});

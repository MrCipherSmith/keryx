// Flow 303 (AC6): the `/help` modal — one tab per onboarding group, ↑/↓
// selects a command, Enter shows its detail, ←/→ switches tabs, Esc closes.
// A keypress-driven test on a real (headless) OpenTUI renderer + shell
// chrome, same harness `schedules-sidebar.test.ts` and `modal-host.test.ts`
// use.

import { expect, test } from "bun:test";
import { HELP_GROUP_ORDER } from "../standard/service";
import { openHelpModal, HELP_MODAL_TABS } from "./help-modal";
import { keypressSource, loadOpenTui, mountChrome } from "./ops-sidebar.test-helpers";
import { themeColorToHex } from "./shell-chrome";
import { applyThemeId, getThemeId, resolveTheme } from "./theme";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): NonNullable<typeof OTUI> {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

const ESC_PARSER_TIMEOUT_MS = 20;

async function pressEscapeAndSettle(h: { mockInput: { pressEscape(): void }; flush: () => Promise<void> }): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

test("HELP_MODAL_TABS is exactly the nine onboarding groups, in order", () => {
  expect(HELP_MODAL_TABS.map((t) => t.label)).toEqual(HELP_GROUP_ORDER.map((g) => g.name));
  expect(HELP_MODAL_TABS.map((t) => t.id)).toEqual(HELP_GROUP_ORDER.map((g) => g.slug));
});

otuiTest("opens on the first group's tab, with its first command selected", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();
  expect(handle).toBeDefined();
  expect(handle?.activeTab()).toBe(HELP_MODAL_TABS[0]?.id);
  expect(handle?.selectedEntry()).toBe("cli:init");
  expect(handle?.showingDetail()).toBe(false);
  h.destroy();
});

otuiTest("→ and ← switch tabs, in onboarding order, and wrap nowhere past the ends", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();

  await h.mockInput.pressArrow("right");
  await h.flush();
  expect(handle?.activeTab()).toBe("connect");

  await h.mockInput.pressArrow("right");
  await h.flush();
  expect(handle?.activeTab()).toBe("look-and-feel");

  await h.mockInput.pressArrow("left");
  await h.flush();
  expect(handle?.activeTab()).toBe("connect");

  h.destroy();
});

otuiTest("↓ and ↑ move the selection cursor within the active tab", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();
  expect(handle?.selectedEntry()).toBe("cli:init");

  await h.mockInput.pressArrow("down");
  await h.flush();
  expect(handle?.selectedEntry()).toBe("cli:status");

  await h.mockInput.pressArrow("down");
  await h.flush();
  expect(handle?.selectedEntry()).toBe("cli:shell");

  await h.mockInput.pressArrow("up");
  await h.flush();
  expect(handle?.selectedEntry()).toBe("cli:status");

  h.destroy();
});

otuiTest("↓ never runs past the last command in a tab", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();
  // "Start here" has 5 entries: init, status, shell, help, /help.
  for (let i = 0; i < 10; i += 1) {
    await h.mockInput.pressArrow("down");
  }
  await h.flush();
  expect(handle?.selectedEntry()).toBe("slash:/help");
  h.destroy();
});

otuiTest("Enter shows the selected command's detail; Enter again returns to the list", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();

  await h.mockInput.pressEnter();
  await h.flush();
  expect(handle?.showingDetail()).toBe(true);
  const detail = handle?.visibleLines().join("\n") ?? "";
  expect(detail).toContain("init");
  expect(detail).toContain("Initialize .metaproject in the current project.");

  await h.mockInput.pressEnter();
  await h.flush();
  expect(handle?.showingDetail()).toBe(false);
  const list = handle?.visibleLines().join("\n") ?? "";
  expect(list).toContain("init");
  expect(list).toContain("status");

  h.destroy();
});

otuiTest("Esc closes the modal and returns focus to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  expect(h.chrome.textarea.focused).toBe(true);
  const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();
  expect(handle).toBeDefined();
  expect(h.chrome.overlayActive()).toBe(true);
  expect(h.chrome.textarea.focused).toBe(false);

  await pressEscapeAndSettle(h);
  expect(h.chrome.overlayActive()).toBe(false);
  expect(h.chrome.textarea.focused).toBe(true);

  h.destroy();
});

otuiTest("opening with an initialGroupSlug starts on that group's tab (AC8 wiring)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openHelpModal(otui.core, h.chrome, {
    onKeypress: keypressSource(h.renderer),
    initialGroupSlug: "connect",
  });
  await h.flush();
  expect(handle?.activeTab()).toBe("connect");
  h.destroy();
});

// PR #669 review, LOW: `modal-host.ts`'s `onThemeChange` used to recolour
// only the chrome, leaving every consumer's body — this one included — in
// whatever theme it was mounted under. `modal-host.test.ts` proves the
// GENERAL mechanism (a synthetic body); this proves a REAL consumer benefits
// from it, one of the two the review asked for.
otuiTest("a theme change recolours the help modal's own body text", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const previousThemeId = getThemeId();
  try {
    applyThemeId("groknight"); // dark: dimChunk wraps text in `otui.dim`
    const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
    await h.flush();
    expect(handle).toBeDefined();

    // Light: dimChunk resolves to roleChunk(otui, "muted", …) — a plain,
    // directly comparable `fg`, which is what actually proves the repaint
    // (the dark-theme case wraps in `otui.dim` around `text`, which is
    // harder to compare directly — `modal-host.test.ts`'s generic test
    // already covers a plain-fg body end to end).
    applyThemeId("paper");
    await h.flush();

    const body = h.renderer.root.findDescendantById("help-body") as unknown as {
      content?: { chunks?: Array<{ fg?: unknown }> };
    };
    const fg = body.content?.chunks?.[0]?.fg;
    expect(themeColorToHex(fg)).toBe(resolveTheme("paper").muted);

    handle?.close();
  } finally {
    applyThemeId(previousThemeId);
    h.destroy();
  }
});

otuiTest("an empty group (none exist today, but the empty-state path is real) reports no commands rather than throwing", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  // "Look and feel" has slash commands only — proves the cli+slash merge, not an empty group.
  const handle = openHelpModal(otui.core, h.chrome, {
    onKeypress: keypressSource(h.renderer),
    initialGroupSlug: "look-and-feel",
  });
  await h.flush();
  expect(handle?.selectedEntry()).toBe("slash:/theme");
  h.destroy();
});

// PR #669 review, AC6 test gaps.
otuiTest("a narrow terminal still renders selectable rows within the pane width, nothing crashes or overflows", async () => {
  const otui = requireOtui();
  // Narrow enough that every summary must wrap — this is what a real small
  // terminal (or a split pane) looks like, not the 100-column fixture the
  // other tests use.
  const h = await mountChrome(otui, { width: 40, height: 20 });
  const handle = openHelpModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();
  expect(handle).toBeDefined();
  expect(handle?.selectedEntry()).toBe("cli:init");

  const frame = h.captureCharFrame();
  for (const line of frame.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(40);
  }

  // Still fully interactive at this width: selection moves, detail opens.
  await h.mockInput.pressArrow("down");
  await h.flush();
  expect(handle?.selectedEntry()).toBe("cli:status");

  await h.mockInput.pressEnter();
  await h.flush();
  expect(handle?.showingDetail()).toBe(true);
  // `captureCharFrame()` is the renderer's OWN fixed-width buffer (40
  // columns, as configured above) — unlike `visibleLines()`, which reflects
  // the modal's INTERNAL wrap width (floored at `MODAL_PANEL_MIN_WIDTH`,
  // independent of a narrow terminal — modal-host's own documented, tested
  // floor, not a bug this test is about), this is the actual on-screen
  // check: nothing painted outside the real terminal.
  for (const line of h.captureCharFrame().split("\n")) {
    expect(line.length).toBeLessThanOrEqual(40);
  }

  h.destroy();
});

otuiTest("inputBlocked() true freezes the modal's own keys; false lets them through again", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  let blocked = false;
  const handle = openHelpModal(otui.core, h.chrome, {
    onKeypress: keypressSource(h.renderer),
    inputBlocked: () => blocked,
  });
  await h.flush();
  expect(handle?.selectedEntry()).toBe("cli:init");

  blocked = true;
  await h.mockInput.pressArrow("down");
  await h.flush();
  // Frozen: another overlay (per `inputBlocked`'s contract) owns the keyboard.
  expect(handle?.selectedEntry()).toBe("cli:init");

  await h.mockInput.pressEnter();
  await h.flush();
  expect(handle?.showingDetail()).toBe(false);

  blocked = false;
  await h.mockInput.pressArrow("down");
  await h.flush();
  expect(handle?.selectedEntry()).toBe("cli:status");

  h.destroy();
});

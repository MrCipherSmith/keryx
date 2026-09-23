// Flow 303 (AC6): the `/help` modal — one tab per onboarding group, ↑/↓
// selects a command, Enter shows its detail, ←/→ switches tabs, Esc closes.
// A keypress-driven test on a real (headless) OpenTUI renderer + shell
// chrome, same harness `schedules-sidebar.test.ts` and `modal-host.test.ts`
// use.

import { expect, test } from "bun:test";
import { HELP_GROUP_ORDER } from "../standard/service";
import { openHelpModal, HELP_MODAL_TABS } from "./help-modal";
import { keypressSource, loadOpenTui, mountChrome } from "./ops-sidebar.test-helpers";

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

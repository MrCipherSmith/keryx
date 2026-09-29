// `/setup` modal — one tab per preparation scenario, ←/→ switches tabs,
// ↑/↓ scrolls, Esc closes. Same headless OpenTUI harness `help-modal.test.ts`
// uses.

import { expect, test } from "bun:test";
import { SETUP_SCENARIOS } from "../commands/setup-guide";
import { keypressSource, loadOpenTui, mountChrome } from "./ops-sidebar.test-helpers";
import { openSetupModal, SETUP_MODAL_KEYS } from "./setup-modal";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): NonNullable<typeof OTUI> {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

const ESC_PARSER_TIMEOUT_MS = 20;

otuiTest("opens on the first scenario and ←/→ walks init, refresh, repair", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openSetupModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();

  expect(handle?.activeTab()).toBe("init");
  const first = handle?.visibleLines().join("\n") ?? "";
  expect(first).toContain(SETUP_MODAL_KEYS);
  expect(first).toContain("From scratch");

  await h.mockInput.pressArrow("right");
  await h.flush();
  expect(handle?.activeTab()).toBe("refresh");
  expect(handle?.visibleLines().join("\n")).toContain("After a pull");

  await h.mockInput.pressArrow("right");
  await h.flush();
  expect(handle?.activeTab()).toBe("repair");
  expect(handle?.visibleLines().join("\n")).toContain("Partial or stale");

  h.destroy();
});

otuiTest("initialScenario opens that tab", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openSetupModal(otui.core, h.chrome, {
    onKeypress: keypressSource(h.renderer),
    initialScenario: "repair",
  });
  await h.flush();
  expect(handle?.activeTab()).toBe("repair");
  h.destroy();
});

otuiTest("↓ scrolls the body and stops at the last line; ↑ comes back to the top", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const rows = 6;
  const handle = openSetupModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer), visibleRows: rows });
  await h.flush();
  const top = handle?.visibleLines() ?? [];
  expect(top[0]).toBe(SETUP_MODAL_KEYS);

  for (let i = 0; i < 200; i += 1) {
    await h.mockInput.pressArrow("down");
  }
  await h.flush();
  const bottom = handle?.visibleLines() ?? [];
  expect(bottom.length).toBe(rows);
  expect(bottom.at(-1)).toBe("This guide only prints the steps. It does not run them.");

  for (let i = 0; i < 200; i += 1) {
    await h.mockInput.pressArrow("up");
  }
  await h.flush();
  expect(handle?.visibleLines()).toEqual(top);

  h.destroy();
});

otuiTest("Esc closes the modal and gives focus back to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  openSetupModal(otui.core, h.chrome, { onKeypress: keypressSource(h.renderer) });
  await h.flush();
  expect(h.chrome.overlayActive()).toBe(true);

  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
  expect(h.chrome.overlayActive()).toBe(false);
  expect(h.chrome.textarea.focused).toBe(true);

  h.destroy();
});

test("the modal has one tab per scenario", () => {
  expect(SETUP_SCENARIOS.map((scenario) => scenario.tab)).toEqual(["Init", "Refresh", "Repair"]);
});

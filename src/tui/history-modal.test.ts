import { expect, test } from "bun:test";
import { openHistoryModal } from "./history-modal";
import { loadOpenTui, mountChrome } from "./ops-sidebar.test-helpers";

const otui = await loadOpenTui();

test.skipIf(otui === undefined)("search jumps to individual hits in long archived messages and keeps its toolbar fixed", async () => {
  const h = await mountChrome(otui!, { width: 110, height: 26, kittyKeyboard: true });
  try {
    const previousFocus = h.renderer.currentFocusedRenderable;
    openHistoryModal(otui!.core, h.chrome, [
      { label: "You", text: "First Needle" },
      {
        label: "Assistant",
        text: [...Array.from({ length: 60 }, (_, i) => `Archive line ${i}`),
          `${"word ".repeat(150)}Later needle`, ...Array(40).fill("More archive"), "Last NEEDLE"].join("\n"),
      },
    ]);
    await h.flush();
    const find = () => h.renderer.root.findDescendantById("history-find")!;
    await h.mockInput.pressKeys(["n", "e", "e", "d", "l", "e"]);
    await h.flush();
    expect(h.captureCharFrame()).toContain("First Needle");
    expect(h.captureCharFrame()).toContain("1/3");
    h.mockInput.pressArrow("down");
    await h.flush();
    expect(h.captureCharFrame()).toContain("Later needle");
    expect(h.captureCharFrame()).toContain("2/3");
    h.mockInput.pressArrow("down");
    await h.flush();
    expect(h.captureCharFrame()).toContain("Last NEEDLE");
    expect(h.captureCharFrame()).toContain("3/3");
    h.mockInput.pressArrow("up");
    await h.flush();
    const scroll = h.renderer.root.findDescendantById("modal-body-scroll");
    if (!(scroll instanceof otui!.core.ScrollBoxRenderable)) throw new Error("Missing history viewport");
    scroll.scrollTo(0);
    await h.flush();
    expect(h.captureCharFrame()).not.toContain("Later needle");
    await h.mockMouse.click(find().x + 2, find().y);
    await h.flush();
    expect(h.captureCharFrame()).toContain("Later needle");
    h.mockInput.pressKey("x");
    await h.flush();
    expect(h.captureCharFrame()).toContain("No matches");
    expect(h.chrome.overlayActive()).toBe(true);
    h.mockInput.pressEscape();
    await h.flush();
    expect(h.chrome.overlayActive()).toBe(false);
    expect(h.renderer.currentFocusedRenderable).toBe(previousFocus);
  } finally {
    h.destroy();
  }
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { historySnapshot } from "./history-reader";
import { openHistoryModal } from "./history-modal";
import { loadOpenTui, mountChrome } from "./ops-sidebar.test-helpers";

const otui = await loadOpenTui();

async function waitForHistoryFrame(h: Awaited<ReturnType<typeof mountChrome>>, predicate: (frame: string) => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  do {
    await h.flush();
    if (predicate(h.captureCharFrame())) return;
    await Bun.sleep(3);
  } while (Date.now() < deadline);
  expect(h.captureCharFrame()).toSatisfy(predicate);
}

test.skipIf(otui === undefined)("search jumps to individual hits in long archived messages and keeps its toolbar fixed", async () => {
  const h = await mountChrome(otui!, { width: 110, height: 26, kittyKeyboard: true });
  try {
    const previousFocus = h.renderer.currentFocusedRenderable;
    openHistoryModal(otui!.core, h.chrome, historySnapshot([
      { role: "user", content: "First Needle" },
      {
        role: "assistant",
        content: [...Array.from({ length: 60 }, (_, i) => `Archive line ${i}`),
          `${"word ".repeat(150)}Later needle`, ...Array(40).fill("More archive"), "Last NEEDLE"].join("\n"),
      },
    ]));
    const waitFor = (text: string) => waitForHistoryFrame(h, (frame) => frame.includes(text));
    await h.flush();
    const find = () => h.renderer.root.findDescendantById("history-find")!;
    await h.mockInput.pressKeys(["n", "e", "e", "d", "l", "e"]);
    await waitFor("1/3");
    expect(h.captureCharFrame()).toContain("First Needle");
    expect(h.captureCharFrame()).toContain("1/3");
    h.mockInput.pressArrow("down");
    await waitFor("Later needle");
    expect(h.captureCharFrame()).toContain("Later needle");
    expect(h.captureCharFrame()).toContain("2/3");
    h.mockInput.pressArrow("down");
    await waitFor("Last NEEDLE");
    expect(h.captureCharFrame()).toContain("Last NEEDLE");
    expect(h.captureCharFrame()).toContain("3/3");
    h.mockInput.pressArrow("up");
    await waitFor("Later needle");
    const scroll = h.renderer.root.findDescendantById("modal-body-scroll");
    if (!(scroll instanceof otui!.core.ScrollBoxRenderable)) throw new Error("Missing history viewport");
    scroll.scrollTo(0);
    await h.flush();
    expect(h.captureCharFrame()).not.toContain("Later needle");
    await h.mockMouse.click(find().x + 2, find().y);
    await waitFor("Later needle");
    expect(h.captureCharFrame()).toContain("Later needle");
    h.mockInput.pressKey("x");
    await waitFor("No matches");
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

test.skipIf(otui === undefined)("a disk archive keeps only one window mounted and scrolls beyond both edges", async () => {
  const h = await mountChrome(otui!, { width: 110, height: 26, kittyKeyboard: true });
  const directory = mkdtempSync(path.join(tmpdir(), "keryx-history-modal-"));
  const messages = Array.from({ length: 1200 }, (_, index) => ({
    role: "assistant" as const,
    content: `Message ${String(index).padStart(4, "0")}${index === 3 || index === 1100 ? " archive hit" : ""}`,
  }));
  writeFileSync(path.join(directory, "archive.jsonl"), messages.map((item) => JSON.stringify(item)).join("\n") + "\n");
  try {
    openHistoryModal(otui!.core, h.chrome, historySnapshot(messages, [], directory));
    const has = (...text: string[]) => waitForHistoryFrame(h, (frame) => text.every((word) => frame.includes(word)));
    await has("Message 1199");
    const row = (index: number) => h.renderer.root.findDescendantById(`history-entry-${index}`);
    const scroll = h.renderer.root.findDescendantById("modal-body-scroll");
    if (!(scroll instanceof otui!.core.ScrollBoxRenderable)) throw new Error("Missing history viewport");
    const mounted = () => scroll.content.getChildren().filter((node) => node.id.startsWith("history-entry-")).length;
    expect(mounted()).toBe(20);
    expect(row(1179)).toBeUndefined();

    scroll.scrollTo(3);
    await h.flush();
    await h.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 3, "up");
    await waitForHistoryFrame(h, () => row(1170) !== undefined && scroll.scrollTop > 0);
    expect(mounted()).toBe(20);
    expect(row(1199)).toBeUndefined();
    scroll.scrollTo(scroll.scrollHeight);
    await waitForHistoryFrame(h, () => row(1199) !== undefined);
    scroll.scrollTo(scroll.scrollHeight);
    await has("Message 1199");
    expect(mounted()).toBe(20);

    const field = h.renderer.root.findDescendantById("history-search");
    if (!(field instanceof otui!.core.InputRenderable)) throw new Error("Missing history input");
    field.value = "archive hit";
    h.mockInput.pressEnter();
    await has("1/2", "Message 0003 archive hit");
    expect(row(1199)).toBeUndefined();
    h.mockInput.pressArrow("up");
    await has("2/2", "Message 1100 archive hit");
    expect(mounted()).toBe(20);
    h.mockInput.pressArrow("down");
    await has("1/2", "Message 0003 archive hit");
    expect(mounted()).toBe(20);
  } finally {
    h.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

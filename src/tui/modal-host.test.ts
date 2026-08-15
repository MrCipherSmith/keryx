// Flow 154 — reusable OpenTUI modal + tab host.
//
// Headless tests of the shipped `openModal` API. Optional `@opentui/core` is
// loaded only here (and inside `loadOpenTui`); `modal-host.ts` must stay
// structurally typed. The optional-dependency guard is a regex over file
// TEXT, so the forbidden import form must not be spelled out in a comment
// in the runtime module.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { createShellChrome, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";
import {
  MODAL_PANEL_INNER_WIDTH,
  MODAL_PANEL_MIN_HEIGHT,
  MODAL_PANEL_MIN_WIDTH,
  formatModalFooter,
  openModal,
  resolveModalPanelSize,
} from "./modal-host";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
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
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

const ESC_PARSER_TIMEOUT_MS = 20;

async function pressEscapeAndSettle(h: {
  mockInput: TestSetup["mockInput"];
  flush: TestSetup["flush"];
}): Promise<void> {
  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
}

const TITLE = "keryx · chrome";
const STATUS = "s/m";
const FOOTER_HINT = "/ commands";
const PLACEHOLDER = "ask keryx";

async function mountChrome(
  otui: OtuiBundle,
  opts: { width?: number; height?: number; chrome?: Partial<ShellChromeOptions> } = {},
): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 120, height: opts.height ?? 40 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: TITLE,
    status: STATUS,
    footerHint: FOOTER_HINT,
    placeholder: PLACEHOLDER,
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

function countById(node: { id: string; getChildren: () => { id: string; getChildren: () => unknown[] }[] }, id: string): number {
  let n = node.id === id ? 1 : 0;
  for (const child of node.getChildren()) {
    n += countById(child as typeof node, id);
  }
  return n;
}

// AC5 / AC7: these do not need a TTY or the optional renderer.
test("AC5: openModal is a no-op when OpenTUI is unavailable", () => {
  const calls: string[] = [];
  const handle = openModal(undefined, undefined, {
    title: "Inspector",
    tabs: [{ id: "a", label: "A" }],
    renderTab: () => {
      calls.push("render");
    },
  });
  expect(handle).toBeUndefined();
  expect(calls).toEqual([]);
});

test("formatModalFooter is a single hint line that fits the panel", () => {
  const line = formatModalFooter([
    { key: "c", label: "copy id" },
    { key: "esc", label: "close" },
  ]);
  expect(line).toBe("c copy id · esc close");
  expect(MODAL_PANEL_INNER_WIDTH).toBe(MODAL_PANEL_MIN_WIDTH - 4);
  expect(line.length).toBeLessThanOrEqual(MODAL_PANEL_INNER_WIDTH);
});

test("resolveModalPanelSize grows toward the target and never shrinks below the floor", () => {
  expect(resolveModalPanelSize(80, 24)).toEqual({ width: 76, height: 20 });
  expect(resolveModalPanelSize(120, 40)).toEqual({ width: 96, height: 28 });
  expect(resolveModalPanelSize(40, 10)).toEqual({ width: MODAL_PANEL_MIN_WIDTH, height: MODAL_PANEL_MIN_HEIGHT });
});

test("AC7: modal-host has no static optional-core import and adds no /session-info", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const host = await readFile(path.join(here, "modal-host.ts"), "utf8");
  expect(host).not.toMatch(/\bimport\b[^()]*?\bfrom\s*['"]@opentui\/core['"]/s);
  expect(host).not.toMatch(/\bimport\s*['"]@opentui\/core['"]/);
  expect(host).not.toMatch(/session-info/);
});

otuiTest("AC1: one tab paints a titled panel and dimmed backdrop; slash menu stays closed on /", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  h.chrome.transcript.add(
    new otui.core.TextRenderable(h.renderer, { id: "keep-me", content: "transcript stays mounted" }),
  );
  await h.flush();

  const handle = openModal(otui.core, h.chrome, {
    title: "Inspector",
    tabs: [{ id: "info", label: "Info" }],
    renderTab: (tabId, body) => {
      const parent = body as { add: (child: unknown) => void };
      parent.add(new otui.core.TextRenderable(h.renderer, { id: `body-${tabId}`, content: `body:${tabId}` }));
    },
  });
  expect(handle).toBeDefined();
  await h.flush();

  const frame = h.captureCharFrame();
  expect(frame).toContain("Inspector");
  expect(frame).toContain("Info");
  expect(frame).toContain("body:info");

  const backdrop = h.renderer.root.findDescendantById("modal-backdrop");
  const panel = h.renderer.root.findDescendantById("modal-panel");
  expect(backdrop).toBeDefined();
  expect(panel).toBeDefined();
  const sized = resolveModalPanelSize(h.renderer.width, h.renderer.height);
  expect((panel as { width: number }).width).toBe(sized.width);
  expect((panel as { height: number }).height).toBe(sized.height);
  expect(frame).toContain("[x] esc");
  expect(frame.toLowerCase()).toContain("esc close");
  expect((backdrop as { opacity?: number }).opacity).toBeLessThan(1);
  expect((backdrop as { opacity?: number }).opacity).toBeGreaterThan(0);

  // Shell remains mounted: chrome header and transcript child are still in the tree.
  expect(h.chrome.header.parent).toBe(h.chrome.main);
  expect(h.renderer.root.findDescendantById("keep-me")).toBeDefined();

  expect(h.chrome.overlayActive()).toBe(true);
  expect(h.chrome.textarea.focused).toBe(false);

  await h.mockInput.pressKeys(["/"]);
  await h.flush();
  expect(h.chrome.menu.visible).toBe(false);
  expect(h.chrome.menuActive()).toBe(false);
  expect(h.chrome.overlayActive()).toBe(true);

  handle?.close();
  h.destroy();
});

otuiTest("AC2: initialTab mounts only that body; switching unmounts the previous (cleanup runs)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 24 });
  const mounted: string[] = [];
  const cleaned: string[] = [];

  const handle = openModal(otui.core, h.chrome, {
    title: "Extensions",
    tabs: [
      { id: "a", label: "Hooks" },
      { id: "b", label: "Plugins" },
    ],
    initialTab: "b",
    renderTab: (tabId, body) => {
      mounted.push(tabId);
      const parent = body as { add: (child: unknown) => void };
      parent.add(new otui.core.TextRenderable(h.renderer, { id: `tab-body-${tabId}`, content: `only-${tabId}` }));
      return () => {
        cleaned.push(tabId);
      };
    },
  });
  await h.flush();

  expect(handle?.activeTab()).toBe("b");
  expect(mounted).toEqual(["b"]);
  expect(h.captureCharFrame()).toContain("only-b");
  expect(h.captureCharFrame()).not.toContain("only-a");
  expect(h.renderer.root.findDescendantById("tab-body-b")).toBeDefined();
  expect(h.renderer.root.findDescendantById("tab-body-a")).toBeUndefined();

  h.mockInput.pressArrow("left");
  await h.flush();
  expect(handle?.activeTab()).toBe("a");
  expect(mounted).toEqual(["b", "a"]);
  expect(cleaned).toEqual(["b"]);
  expect(h.captureCharFrame()).toContain("only-a");
  expect(h.captureCharFrame()).not.toContain("only-b");
  expect(h.renderer.root.findDescendantById("tab-body-a")).toBeDefined();
  expect(h.renderer.root.findDescendantById("tab-body-b")).toBeUndefined();

  handle?.close();
  expect(cleaned).toEqual(["b", "a"]);
  h.destroy();
});

otuiTest("fixed panel size does not change when switching short and long tab bodies", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui);
  const handle = openModal(otui.core, h.chrome, {
    title: "/status",
    tabs: [
      { id: "long", label: "Session" },
      { id: "short", label: "Usage" },
    ],
    renderTab: (tabId, body) => {
      const parent = body as { add: (child: unknown) => void };
      const content = tabId === "long" ? "L\n".repeat(12) : "s";
      parent.add(new otui.core.TextRenderable(h.renderer, { id: `sz-${tabId}`, content }));
    },
    footer: [
      { key: "c", label: "copy id" },
      { key: "esc", label: "close" },
    ],
  });
  await h.flush();
  const panel = h.renderer.root.findDescendantById("modal-panel") as { width: number; height: number };
  const sized = resolveModalPanelSize(h.renderer.width, h.renderer.height);
  expect(panel.width).toBe(sized.width);
  expect(panel.height).toBe(sized.height);
  const first = { width: panel.width, height: panel.height };
  h.mockInput.pressArrow("right");
  await h.flush();
  const after = h.renderer.root.findDescendantById("modal-panel") as { width: number; height: number };
  expect(after.width).toBe(first.width);
  expect(after.height).toBe(first.height);
  const frame = h.captureCharFrame();
  expect(frame).toContain("/status");
  expect(frame).toContain("[x] esc");
  expect(frame).toContain(formatModalFooter([{ key: "c", label: "copy id" }, { key: "esc", label: "close" }]));
  handle?.close();
  h.destroy();
});

otuiTest("x closes the modal the same as Esc", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 24 });
  let closed = 0;
  openModal(otui.core, h.chrome, {
    title: "Inspector",
    tabs: [{ id: "info", label: "Info" }],
    renderTab: () => {},
    onClose: () => {
      closed += 1;
    },
  });
  await h.flush();
  await h.mockInput.pressKeys(["x"]);
  await h.flush();
  expect(closed).toBe(1);
  expect(h.chrome.overlayActive()).toBe(false);
  h.destroy();
});

otuiTest("AC3: sequential openModal calls replace on one host (no second overlay stack)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 24 });
  const closed: string[] = [];

  const first = openModal(otui.core, h.chrome, {
    title: "Extensions",
    tabs: [
      { id: "hooks", label: "Hooks" },
      { id: "plugins", label: "Plugins" },
    ],
    initialTab: "hooks",
    renderTab: (tabId, body) => {
      const parent = body as { add: (child: unknown) => void };
      parent.add(new otui.core.TextRenderable(h.renderer, { id: `seq-${tabId}`, content: `seq:${tabId}` }));
    },
    onClose: () => closed.push("hooks-modal"),
  });
  await h.flush();
  const backdrop = h.renderer.root.findDescendantById("modal-backdrop");
  expect(first?.activeTab()).toBe("hooks");
  expect(h.captureCharFrame()).toContain("seq:hooks");
  expect(countById(h.renderer.root, "modal-backdrop")).toBe(1);

  const second = openModal(otui.core, h.chrome, {
    title: "Extensions",
    tabs: [
      { id: "hooks", label: "Hooks" },
      { id: "plugins", label: "Plugins" },
    ],
    initialTab: "plugins",
    renderTab: (tabId, body) => {
      const parent = body as { add: (child: unknown) => void };
      parent.add(new otui.core.TextRenderable(h.renderer, { id: `seq-${tabId}`, content: `seq:${tabId}` }));
    },
    onClose: () => closed.push("plugins-modal"),
  });
  await h.flush();

  expect(closed).toEqual(["hooks-modal"]);
  expect(second?.activeTab()).toBe("plugins");
  expect(h.captureCharFrame()).toContain("seq:plugins");
  expect(h.captureCharFrame()).not.toContain("seq:hooks");
  expect(h.renderer.root.findDescendantById("modal-backdrop")).toBe(backdrop);
  expect(countById(h.renderer.root, "modal-backdrop")).toBe(1);
  expect(countById(h.renderer.root, "modal-panel")).toBe(1);

  second?.close();
  expect(closed).toEqual(["hooks-modal", "plugins-modal"]);
  h.destroy();
});

otuiTest("AC4: Esc closes, runs onClose, restores composer focus, overlayActive is false", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 24 });
  expect(h.chrome.textarea.focused).toBe(true);
  const savedDraft = "keep this draft";
  h.chrome.input.value = savedDraft;
  const priorScroll = h.chrome.scroll.scrollTop;

  let closed = 0;
  const handle = openModal(otui.core, h.chrome, {
    title: "Inspector",
    tabs: [{ id: "info", label: "Info" }],
    renderTab: (tabId, body) => {
      const parent = body as { add: (child: unknown) => void };
      parent.add(new otui.core.TextRenderable(h.renderer, { id: `esc-${tabId}`, content: `esc:${tabId}` }));
    },
    onClose: () => {
      closed += 1;
    },
  });
  await h.flush();
  expect(handle).toBeDefined();
  expect(h.chrome.overlayActive()).toBe(true);
  expect(h.chrome.textarea.focused).toBe(false);

  await pressEscapeAndSettle(h);
  expect(closed).toBe(1);
  expect(h.chrome.overlayActive()).toBe(false);
  expect(h.chrome.textarea.focused).toBe(true);
  expect(h.chrome.input.value).toBe(savedDraft);
  expect(h.chrome.scroll.scrollTop).toBe(priorScroll);
  expect(h.renderer.root.findDescendantById("modal-backdrop")?.visible).toBe(false);
  expect(h.captureCharFrame()).not.toContain("esc:info");

  handle?.close();
  expect(closed).toBe(1);
  h.destroy();
});

otuiTest("AC6: unknown initialTab falls back to the first tab", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 24 });
  const handle = openModal(otui.core, h.chrome, {
    title: "Inspector",
    tabs: [
      { id: "first", label: "First" },
      { id: "second", label: "Second" },
    ],
    initialTab: "missing",
    renderTab: (tabId, body) => {
      const parent = body as { add: (child: unknown) => void };
      parent.add(new otui.core.TextRenderable(h.renderer, { id: `fb-${tabId}`, content: `fb:${tabId}` }));
    },
  });
  await h.flush();
  expect(handle?.activeTab()).toBe("first");
  expect(h.captureCharFrame()).toContain("fb:first");
  handle?.close();
  h.destroy();
});

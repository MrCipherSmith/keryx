// Reusable modal panel + tab strip for the OpenTUI shell (flow 154).
//
// Presentation only: callers own tab bodies via `renderTab`. The host registers
// as a chrome overlay source, paints an opaque full-window backdrop with a
// small inset bordered panel, and replaces an already-open modal on the same
// renderer instead of stacking. The panel must not sit under a parent
// `opacity < 1` — OpenTUI multiplies child alpha, which lets the transcript
// bleed through the modal.
//
// The optional renderer package is referenced ONLY structurally, through
// `typeof import(...)`. There is no top-level import of it (the static guard
// in `src/capability/no-optional-imports` is a regex over file text).
import type { ShellChrome } from "./shell-chrome";
import { getTheme, onThemeChange } from "./theme";
import { clearTranscriptChildren } from "./transcript-blocks";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;
type ScrollBox = InstanceType<OpenTui["ScrollBoxRenderable"]>;

export type ModalTab = { id: string; label: string };

export type ModalFooterAction = { key: string; label: string };

export type ModalTabContext = {
  /** Columns available inside the panel after border + padding. */
  width: number;
};

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  /** Footer key-hints. Default: tab switch + Esc close. */
  footer?: readonly ModalFooterAction[];
  renderTab: (tabId: string, body: unknown, ctx: ModalTabContext) => void | (() => void);
  /** Claim left/right arrows before modal-host's tab switch. */
  onArrowKeys?: (key: KeypressEvent, direction: "left" | "right") => boolean | undefined;
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type ModalChrome = Pick<
  ShellChrome,
  "renderer" | "overlayActive" | "addOverlaySource" | "focusComposer" | "blurComposer" | "hideMenu" | "scroll"
>;

type KeypressEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift?: boolean;
  sequence: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

function onKeypress(r: Renderer, handler: (key: KeypressEvent) => void): () => void {
  r._internalKeyInput.onInternal("keypress", handler);
  return () => r._internalKeyInput.offInternal("keypress", handler);
}

const BACKDROP_ID = "modal-backdrop";
const PANEL_ID = "modal-panel";
/** How much of the transcript stays visible through the backdrop, 0-1. */
export const BACKDROP_ALPHA = 0.85;

/**
 * The backdrop's fill: the theme's own background hex, alpha-reduced so the
 * transcript peeks through around the (fully opaque) panel. `RGBA` comes off
 * the runtime `otui` parameter, never a top-level `@opentui/core` import —
 * this module's own optional-dependency rule (see the file header).
 */
function backdropFillColor(otui: OpenTui): InstanceType<OpenTui["RGBA"]> {
  const color = otui.RGBA.fromHex(getTheme().bg);
  color.a = BACKDROP_ALPHA;
  return color;
}
/** Inset between the opaque backdrop edge and the bordered panel. */
export const MODAL_PANEL_MARGIN = 1;
/** Border (2) + horizontal padding (2). Subtract from the panel to wrap text. */
export const MODAL_PANEL_CHROME_X = 4;
/** Floor so a 24-row test TTY still fits; live shells occupy the ratio below. */
export const MODAL_PANEL_MIN_WIDTH = 72;
export const MODAL_PANEL_MIN_HEIGHT = 18;
/** The panel occupies this fraction of the terminal — not a fixed target size — so it stays a small box in the middle of a large terminal instead of one that fills it. */
export const MODAL_PANEL_SIZE_RATIO = 0.95;
/** Header + tab strip + footer + rounded border. */
export const MODAL_CHROME_ROWS = 5;
/** @deprecated Use resolveModalPanelSize; kept as the floor for footer-fit tests. */
export const MODAL_PANEL_WIDTH = MODAL_PANEL_MIN_WIDTH;
export const MODAL_PANEL_HEIGHT = MODAL_PANEL_MIN_HEIGHT;
/** Fallback wrap budget before the panel has a measured width. */
export const MODAL_PANEL_INNER_WIDTH = MODAL_PANEL_MIN_WIDTH - MODAL_PANEL_CHROME_X;

export function resolveModalPanelSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: Math.max(MODAL_PANEL_MIN_WIDTH, Math.round(cols * MODAL_PANEL_SIZE_RATIO)),
    height: Math.max(MODAL_PANEL_MIN_HEIGHT, Math.round(rows * MODAL_PANEL_SIZE_RATIO)),
  };
}

export function modalBodyRows(panelHeight: number): number {
  return Math.max(1, panelHeight - MODAL_CHROME_ROWS);
}
const CLOSE_HINT = "[x] esc";

export function resolveModalInnerWidth(availableWidth: number): number {
  return Math.max(20, availableWidth - MODAL_PANEL_CHROME_X);
}
const DEFAULT_FOOTER: readonly ModalFooterAction[] = [
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
];

export function formatModalFooter(actions: readonly ModalFooterAction[]): string {
  return actions.map((action) => `${action.key} ${action.label}`).join(" · ");
}

type HostState = {
  otui: OpenTui;
  chrome: ModalChrome;
  backdrop: Box;
  panel: Box;
  header: Box;
  titleText: Text;
  closeText: Text;
  tabStrip: Box;
  scroll: ScrollBox;
  body: Box;
  footer: Box;
  footerText: Text;
  open: boolean;
  generation: number;
  tabs: readonly ModalTab[];
  active: string;
  tabCleanup: (() => void) | undefined;
  onClose: (() => void) | undefined;
  input: OpenModalInput | undefined;
  releaseOverlay: (() => void) | undefined;
  unsubKeys: (() => void) | undefined;
  savedScrollTop: number | undefined;
  unsubTheme: () => void;
};

const hosts = new WeakMap<Renderer, HostState>();

/**
 * Review finding: `ensureHost` registers an `onThemeChange` listener once per
 * renderer, but `hosts` being a `WeakMap` only lets the STATE object itself
 * be collected — `theme.ts`'s own `listeners` Set is a process-lifetime,
 * non-weak Set, so the listener closure (holding `state.backdrop`/
 * `state.panel`) keeps the whole renderer's modal boxes alive forever once
 * registered. Any caller that creates more than one renderer per process
 * (every OpenTUI test suite; a relaunched TUI shell within one process) must
 * call this when tearing its renderer down, or every later `applyThemeId()`
 * keeps writing onto boxes belonging to renderers nobody can reach anymore.
 */
export function destroyModalHost(renderer: Renderer): void {
  hosts.get(renderer)?.unsubTheme();
}


/** Shared with `composer-choice.ts` — one renderable-tree containment walk, not two copies. */
export function containsNode(root: { getChildren: () => unknown[] }, node: unknown): boolean {
  if (root === node) {
    return true;
  }
  for (const child of root.getChildren()) {
    if (containsNode(child as { getChildren: () => unknown[] }, node)) {
      return true;
    }
  }
  return false;
}

function resolveInitialTab(tabs: readonly ModalTab[], initialTab: string | undefined): string {
  const first = tabs[0];
  if (first === undefined) {
    return "";
  }
  if (initialTab !== undefined && tabs.some((tab) => tab.id === initialTab)) {
    return initialTab;
  }
  return first.id;
}

function innerWidthOf(state: HostState): number {
  const panelWidth = state.panel.width;
  if (typeof panelWidth === "number" && panelWidth > MODAL_PANEL_CHROME_X) {
    return panelWidth - MODAL_PANEL_CHROME_X;
  }
  return resolveModalInnerWidth(state.chrome.renderer.width - MODAL_PANEL_MARGIN * 2);
}

function paintTabs(state: HostState): void {
  clearTranscriptChildren(state.tabStrip);
  for (const [index, tab] of state.tabs.entries()) {
    const active = tab.id === state.active;
    const label = active ? `[${tab.label}]` : ` ${tab.label} `;
    const prefix = index === 0 ? "" : " ";
    state.tabStrip.add(
      new state.otui.TextRenderable(state.chrome.renderer, {
        id: `modal-tab-${tab.id}`,
        content: active
          ? state.otui.t`${prefix}${state.otui.bold(label)}`
          : state.otui.t`${prefix}${state.otui.dim(label)}`,
        onMouseDown: () => {
          if (!state.open || state.input === undefined || tab.id === state.active) {
            return;
          }
          mountTab(state, state.input, tab.id);
        },
      }),
    );
  }
}

function paintHeader(state: HostState, title: string): void {
  const maxTitle = Math.max(8, innerWidthOf(state) - CLOSE_HINT.length - 1);
  const shown = title.length > maxTitle ? `${title.slice(0, Math.max(1, maxTitle - 1))}…` : title;
  state.titleText.content = state.otui.t`${state.otui.bold(shown)}`;
  state.closeText.content = state.otui.t`${state.otui.dim(CLOSE_HINT)}`;
}

function paintFooter(state: HostState, actions: readonly ModalFooterAction[] | undefined): void {
  const items = actions !== undefined && actions.length > 0 ? actions : DEFAULT_FOOTER;
  state.footerText.content = state.otui.t`${state.otui.dim(formatModalFooter(items))}`;
}

function unmountActiveTab(state: HostState): void {
  const cleanup = state.tabCleanup;
  state.tabCleanup = undefined;
  if (cleanup !== undefined) {
    cleanup();
  }
  clearTranscriptChildren(state.body);
  state.scroll.scrollTop = 0;
}

function mountTab(state: HostState, input: OpenModalInput, tabId: string): void {
  unmountActiveTab(state);
  state.active = tabId;
  paintTabs(state);
  const cleanup = input.renderTab(tabId, state.body, { width: innerWidthOf(state) });
  state.tabCleanup = typeof cleanup === "function" ? cleanup : undefined;
}

function closeHost(state: HostState, opts: { restoreFocus: boolean; runOnClose: boolean }): void {
  if (!state.open) {
    return;
  }
  unmountActiveTab(state);
  state.open = false;
  state.input = undefined;
  state.backdrop.visible = false;
  const onClose = state.onClose;
  state.onClose = undefined;
  if (opts.restoreFocus) {
    const scroll = state.chrome.scroll;
    if (state.savedScrollTop !== undefined && scroll !== undefined) {
      scroll.scrollTop = state.savedScrollTop;
    }
    state.chrome.focusComposer();
  }
  if (opts.runOnClose && onClose !== undefined) {
    onClose();
  }
}

function ensureHost(otui: OpenTui, chrome: ModalChrome): HostState {
  const existing = hosts.get(chrome.renderer);
  if (existing !== undefined) {
    return existing;
  }
  const r = chrome.renderer;
  const backdrop = new otui.BoxRenderable(r, {
    id: BACKDROP_ID,
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    // A translucent FILL COLOR (the color's own alpha channel), never the
    // `opacity` prop: `opacity` composes onto every descendant (this box's
    // own docstring above records the transcript-bleed-through regression
    // that came from setting it on a modal ancestor), so `panel` — a real
    // child of this box, added below — would fade along with it. Baking
    // alpha into backgroundColor's RGBA instead only affects backdrop's own
    // painted pixels; `panel`'s unrelated `backgroundColor` (still a plain
    // opaque string) is untouched either way.
    backgroundColor: backdropFillColor(otui),
    zIndex: 100,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    visible: false,
  });
  // Fixed (not flex-filling) size: `openModal` imperatively sets width/height
  // to `resolveModalPanelSize`'s result every time it opens, so the panel
  // occupies 95% of the terminal and floors at 72x18 for a tiny terminal,
  // rather than a plain `flexGrow`/`"100%"` here, which would fill the
  // backdrop and win on the next layout pass regardless of what was assigned
  // (and would butt the panel right up against the screen edge with no
  // visible backdrop margin).
  const panel = new otui.BoxRenderable(r, {
    id: PANEL_ID,
    width: MODAL_PANEL_WIDTH,
    height: MODAL_PANEL_HEIGHT,
    flexShrink: 0,
    flexGrow: 0,
    flexDirection: "column",
    borderStyle: "rounded",
    border: true,
    borderColor: getTheme().border,
    backgroundColor: getTheme().panel,
    paddingLeft: 1,
    paddingRight: 1,
    zIndex: 101,
  });
  const header = new otui.BoxRenderable(r, {
    id: "modal-header",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    justifyContent: "space-between",
  });
  const titleText = new otui.TextRenderable(r, {
    id: "modal-title",
    content: "",
    flexGrow: 1,
  });
  const closeText = new otui.TextRenderable(r, {
    id: "modal-close",
    content: "",
    flexShrink: 0,
    onMouseDown: () => {
      const current = hosts.get(r);
      if (current !== undefined && current.open) {
        closeHost(current, { restoreFocus: true, runOnClose: true });
      }
    },
  });
  header.add(titleText);
  header.add(closeText);
  const tabStrip = new otui.BoxRenderable(r, {
    id: "modal-tab-strip",
    flexShrink: 0,
    width: "100%",
    height: 1,
    flexDirection: "row",
    focusable: true,
  });
  const scroll = new otui.ScrollBoxRenderable(r, {
    id: "modal-body-scroll",
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    contentOptions: { flexDirection: "column" },
  });
  const body = scroll.content;
  body.id = "modal-body";
  const footer = new otui.BoxRenderable(r, {
    id: "modal-footer",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
  });
  const footerText = new otui.TextRenderable(r, {
    id: "modal-footer-text",
    content: "",
  });
  footer.add(footerText);
  panel.add(header);
  panel.add(tabStrip);
  panel.add(scroll);
  panel.add(footer);
  backdrop.add(panel);
  r.root.add(backdrop);

  const state: HostState = {
    otui,
    chrome,
    backdrop,
    panel,
    header,
    titleText,
    closeText,
    tabStrip,
    scroll,
    body,
    footer,
    footerText,
    open: false,
    generation: 0,
    tabs: [],
    active: "",
    tabCleanup: undefined,
    onClose: undefined,
    input: undefined,
    releaseOverlay: undefined,
    unsubKeys: undefined,
    savedScrollTop: undefined,
    unsubTheme: () => {},
  };

  state.releaseOverlay = chrome.addOverlaySource(() => state.open);
  state.unsubKeys = onKeypress(r, (key) => {
    if (!state.open || state.input === undefined) {
      return;
    }
    const focused = r.currentFocusedRenderable;
    const inBody = focused !== null && containsNode(state.scroll, focused);
    if (key.name === "escape") {
      closeHost(state, { restoreFocus: true, runOnClose: true });
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if ((key.name === "x" || key.sequence === "x") && !inBody) {
      closeHost(state, { restoreFocus: true, runOnClose: true });
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    const idx = state.tabs.findIndex((tab) => tab.id === state.active);
    const onStrip = focused !== null && containsNode(state.tabStrip, focused);
    // The arrows can be claimed by the tab body (review buttons) BEFORE the
    // tab-switch below; tab/shift+tab remain modal-host's own switch.
    const claimArrow = (direction: "left" | "right"): boolean =>
      state.input?.onArrowKeys?.(key, direction) === true;
    if (key.name === "left" && claimArrow("left")) {
      return;
    }
    if (key.name === "right" && claimArrow("right")) {
      return;
    }
    if (key.name === "left" || (onStrip && key.name === "tab" && key.shift === true)) {
      const prev = idx > 0 ? state.tabs[idx - 1] : undefined;
      if (prev !== undefined) {
        mountTab(state, state.input, prev.id);
      }
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "right" || (onStrip && key.name === "tab")) {
      const next = state.tabs[idx + 1];
      if (next !== undefined) {
        mountTab(state, state.input, next.id);
      }
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    // MT-5: 1…9 jump only when the tab body is not capturing digits.
    // Review finding: this used to re-check `state.body` instead of reusing
    // `inBody` (computed above from `state.scroll`, the same container the
    // x-close guard uses) — when focus lands on `state.scroll` itself rather
    // than a descendant of `state.body`, the two checks disagreed: x-close
    // correctly treated it as "in body" but this one didn't, so a stray
    // digit keypress jumped tabs instead of being absorbed by the scroll box.
    if (inBody) {
      return;
    }
    const digit = key.sequence.length === 1 ? key.sequence : key.name;
    if (digit.length === 1 && digit >= "1" && digit <= "9") {
      const jump = state.tabs[Number(digit) - 1];
      if (jump !== undefined) {
        mountTab(state, state.input, jump.id);
        key.preventDefault();
        key.stopPropagation();
      }
    }
  });

  hosts.set(r, state);
  state.unsubTheme = onThemeChange((theme) => {
    state.backdrop.backgroundColor = theme.bg;
    state.panel.backgroundColor = theme.panel;
    state.panel.borderColor = theme.border;
  });
  return state;
}

function makeHandle(state: HostState, generation: number): ModalHandle {
  return {
    close(): void {
      if (state.generation !== generation) {
        return;
      }
      closeHost(state, { restoreFocus: true, runOnClose: true });
    },
    setTab(id: string): void {
      if (state.generation !== generation || !state.open || state.input === undefined) {
        return;
      }
      if (!state.tabs.some((tab) => tab.id === id) || id === state.active) {
        return;
      }
      mountTab(state, state.input, id);
    },
    activeTab(): string {
      return state.active;
    },
  };
}

/**
 * Open (or replace) the single modal host on `chrome.renderer`.
 * Missing OpenTUI / chrome / tabs is a typed no-op so readline stays unchanged.
 */
export function openModal(
  otui: OpenTui | undefined,
  chrome: ModalChrome | undefined,
  input: OpenModalInput,
): ModalHandle | undefined {
  if (otui === undefined || chrome === undefined || input.tabs.length < 1) {
    return undefined;
  }

  const state = ensureHost(otui, chrome);
  const size = resolveModalPanelSize(chrome.renderer.width, chrome.renderer.height);
  state.panel.width = size.width;
  state.panel.height = size.height;

  if (state.open) {
    unmountActiveTab(state);
    const previousClose = state.onClose;
    state.onClose = undefined;
    previousClose?.();
  } else {
    state.savedScrollTop = chrome.scroll.scrollTop;
    chrome.hideMenu();
    chrome.blurComposer();
    state.backdrop.visible = true;
    state.open = true;
  }

  state.generation += 1;
  const generation = state.generation;
  state.input = input;
  state.tabs = input.tabs;
  state.onClose = input.onClose;
  paintHeader(state, input.title);
  paintFooter(state, input.footer);
  mountTab(state, input, resolveInitialTab(input.tabs, input.initialTab));
  state.tabStrip.focus();
  return makeHandle(state, generation);
}

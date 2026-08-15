// Reusable modal panel + tab strip for the OpenTUI shell (flow 154).
//
// Presentation only: callers own tab bodies via `renderTab`. The host registers
// as a chrome overlay source, paints a dimmed backdrop (not a 100% overlayBox),
// and replaces an already-open modal on the same renderer instead of stacking.
//
// The optional renderer package is referenced ONLY structurally, through
// `typeof import(...)`. There is no top-level import of it (the static guard
// in `src/capability/no-optional-imports` is a regex over file text).
import type { ShellChrome } from "./shell-chrome";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

export type ModalTab = { id: string; label: string };

export type ModalFooterAction = { key: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  /** Footer key-hints. Default: tab switch + Esc close. */
  footer?: readonly ModalFooterAction[];
  renderTab: (tabId: string, body: unknown) => void | (() => void);
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
const BACKDROP_OPACITY = 0.45;
/** Fixed panel so tab bodies of different lengths do not resize the chrome. */
export const MODAL_PANEL_WIDTH = 72;
export const MODAL_PANEL_HEIGHT = 18;
/** Inner columns after rounded border + horizontal padding. */
export const MODAL_PANEL_INNER_WIDTH = MODAL_PANEL_WIDTH - 4;
const CLOSE_HINT = "[x] esc";
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
};

const hosts = new WeakMap<Renderer, HostState>();

function clearChildren(box: Box): void {
  for (const child of [...box.getChildren()]) {
    box.remove(child);
  }
}

function containsNode(root: { getChildren: () => unknown[] }, node: unknown): boolean {
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

function paintTabs(state: HostState): void {
  clearChildren(state.tabStrip);
  const labels = state.tabs
    .map((tab) => (tab.id === state.active ? `[${tab.label}]` : ` ${tab.label} `))
    .join(" ");
  state.tabStrip.add(
    new state.otui.TextRenderable(state.chrome.renderer, {
      id: "modal-tabs",
      content: state.otui.t`${state.otui.dim(labels)}`,
    }),
  );
}

function paintHeader(state: HostState, title: string): void {
  state.titleText.content = state.otui.t`${state.otui.bold(title)}`;
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
  clearChildren(state.body);
}

function mountTab(state: HostState, input: OpenModalInput, tabId: string): void {
  unmountActiveTab(state);
  state.active = tabId;
  paintTabs(state);
  const cleanup = input.renderTab(tabId, state.body);
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
    backgroundColor: "#000000",
    opacity: BACKDROP_OPACITY,
    zIndex: 100,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    visible: false,
  });
  const panel = new otui.BoxRenderable(r, {
    id: PANEL_ID,
    width: MODAL_PANEL_WIDTH,
    height: MODAL_PANEL_HEIGHT,
    flexShrink: 0,
    flexGrow: 0,
    flexDirection: "column",
    borderStyle: "rounded",
    border: true,
    borderColor: "#3a4a4a",
    backgroundColor: "#0f1b1b",
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
  const body = new otui.BoxRenderable(r, {
    id: "modal-body",
    width: "100%",
    flexGrow: 1,
    minHeight: 1,
    flexDirection: "column",
  });
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
  panel.add(body);
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
  };

  state.releaseOverlay = chrome.addOverlaySource(() => state.open);
  state.unsubKeys = onKeypress(r, (key) => {
    if (!state.open || state.input === undefined) {
      return;
    }
    if (key.name === "escape" || key.name === "x" || key.sequence === "x") {
      closeHost(state, { restoreFocus: true, runOnClose: true });
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    const idx = state.tabs.findIndex((tab) => tab.id === state.active);
    const focused = r.currentFocusedRenderable;
    const onStrip = focused !== null && containsNode(state.tabStrip, focused);
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
    if (focused !== null && containsNode(state.body, focused)) {
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

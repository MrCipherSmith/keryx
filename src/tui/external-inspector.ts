// External child inspector modal — Work / Meta / Command (flow 176, T16).
// Package: docs/requirements/keryx-external-agent-runtime §8.2; D-11.
//
// Presentation only. Every string shown here is produced by the pure formatters
// in `./external-transcript`; this file just mounts them into the shared
// `openModal` host and keeps them fresh while the child runs. That split is what
// lets the entire operator surface be tested headless: the tests below drive
// `presentExternalInspector` with a fake modal host and fake renderables, and
// never touch a TTY.
//
// Two constraints are load-bearing and both look removable:
//
//   1. NO TOP-LEVEL `@opentui/core` IMPORT. The renderer is an OPTIONAL
//      dependency; TUI code must degrade to a no-op when it is absent, and the
//      static guard in `src/capability/no-optional-imports` is a regex over file
//      text. So the OpenTUI constructors arrive as an untyped `otui` parameter,
//      exactly as `subagent-inspector.ts` does.
//   2. NO `alignSelf` ON THE TRANSCRIPT BOX. Setting it collapses the box's
//      intrinsic height in OpenTUI, and a transcript with zero height renders as
//      an empty modal that looks like a dead child.
import { openModal } from "./modal-host";
import {
  formatExternalCommand,
  formatExternalMeta,
  formatExternalWork,
  type ExternalRunView,
} from "./external-transcript";
import type { ExternalStoreHint } from "./external-session";

/** Footer hints for the external inspector. Same vocabulary as the subagent modal. */
export const EXTERNAL_INSPECTOR_FOOTER = [
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

/** Shown in every tab once the tracked run has been dropped from the store. */
export const EXTERNAL_RUN_GONE = "External run is gone.";

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown) => void | (() => void);
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

/** The modal host, injected so tests can supply a fake without a renderer. */
export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

/** The minimum a store must offer this modal. `ExternalRunStore` satisfies it. */
export interface ExternalRunSource {
  get(id: string): ExternalRunView | undefined;
  subscribe(listener: (hint: ExternalStoreHint) => void): () => void;
}

export type PresentExternalInspectorOptions = {
  store: ExternalRunSource;
  id: string;
  renderer?: unknown;
};

type TextNode = { content: string };

type OtuiLike = {
  TextRenderable?: new (renderer: unknown, opts: { id: string; content: string }) => TextNode;
  ScrollBoxRenderable?: new (
    renderer: unknown,
    opts: {
      id: string;
      flexGrow?: number;
      minHeight?: number;
      scrollY?: boolean;
      stickyScroll?: boolean;
      stickyStart?: string;
      contentOptions?: { flexDirection: string };
    },
  ) => { content?: { add?: (child: unknown) => void }; add?: (child: unknown) => void };
};

/**
 * Paint one tab body, inside a sticky-bottom scroll box where the renderer
 * offers one. Returns the text node so the caller can refresh it in place.
 *
 * Sticky-bottom matters for Work specifically: a live external transcript grows
 * while the operator reads it, and a view that does not follow the tail shows a
 * frozen window on a run that is still moving.
 */
function paintContent(otui: unknown, renderer: unknown, body: unknown, id: string, content: string): TextNode | undefined {
  if (otui === undefined || otui === null || body === undefined || body === null) return undefined;
  const parent = body as { add?: (child: unknown) => void };
  const textCtor = (otui as OtuiLike).TextRenderable;
  if (parent.add === undefined || textCtor === undefined) return undefined;

  const scrollCtor = (otui as OtuiLike).ScrollBoxRenderable;
  let target: { add?: (child: unknown) => void } = parent;
  if (scrollCtor !== undefined) {
    // No `alignSelf` here — see the file header. `flexGrow: 1` + `minHeight: 0`
    // is the combination that fills the panel without collapsing.
    const scroll = new scrollCtor(renderer, {
      id: `${id}-scroll`,
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column" },
    });
    parent.add(scroll);
    if (scroll.content !== undefined) target = scroll.content;
  }
  if (target.add === undefined) return undefined;
  const node = new textCtor(renderer, { id, content });
  target.add(node);
  return node;
}

/** Modal title: the agent label plus the model, when one was pinned. */
export function externalInspectorTitle(view: ExternalRunView): string {
  const agent = view.agentLabel ?? view.agentId;
  const model = view.model !== undefined && view.model.length > 0 ? ` · ${view.model}` : "";
  return `${agent}${model}`;
}

/**
 * Open the Work / Meta / Command modal for one external run and keep it live.
 *
 * `openModalFn` is injected so the whole flow is exercisable with no renderer.
 * Returns `undefined` — never throws — when the id is unknown or the host
 * refuses to open, because a missing child is a normal race (it may have been
 * cleared by a new turn) and not a programming error.
 */
export function presentExternalInspector(
  openModalFn: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentExternalInspectorOptions,
): ModalHandle | undefined {
  const view = options.store.get(options.id);
  if (view === undefined) return undefined;

  let workNode: TextNode | undefined;
  let metaNode: TextNode | undefined;
  let commandNode: TextNode | undefined;
  let unsubscribe: (() => void) | undefined;

  const refresh = (hint?: ExternalStoreHint): void => {
    // A bulk `clear()` (wildcard id "*") must still refresh THIS inspector — it
    // is exactly the case where the tracked run was dropped out from under an
    // already-open modal.
    if (hint !== undefined && hint.id !== "*" && hint.id !== options.id) return;
    const current = options.store.get(options.id);
    if (current === undefined) {
      for (const node of [workNode, metaNode, commandNode]) {
        if (node !== undefined) node.content = EXTERNAL_RUN_GONE;
      }
      return;
    }
    if (workNode !== undefined) workNode.content = formatExternalWork(current.events);
    if (metaNode !== undefined) metaNode.content = formatExternalMeta(current);
    if (commandNode !== undefined) commandNode.content = formatExternalCommand(current);
  };

  const handle = openModalFn(otui, chrome, {
    title: externalInspectorTitle(view),
    tabs: [
      { id: "work", label: "Work" },
      { id: "meta", label: "Meta" },
      { id: "command", label: "Command" },
    ],
    initialTab: "work",
    footer: EXTERNAL_INSPECTOR_FOOTER,
    renderTab: (tabId, body) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const current = options.store.get(options.id);
      if (current === undefined) {
        paintContent(otui, renderer, body, "external-inspector-body", EXTERNAL_RUN_GONE);
        return;
      }
      if (tabId === "meta") {
        metaNode = paintContent(otui, renderer, body, "external-inspector-meta", formatExternalMeta(current));
        return;
      }
      if (tabId === "command") {
        commandNode = paintContent(
          otui,
          renderer,
          body,
          "external-inspector-command",
          formatExternalCommand(current),
        );
        return;
      }
      workNode = paintContent(otui, renderer, body, "external-inspector-work", formatExternalWork(current.events));
    },
    onClose: () => {
      unsubscribe?.();
    },
  });
  if (handle === undefined) return undefined;
  unsubscribe = options.store.subscribe(refresh);
  return handle;
}

/** Open the shared host on Work + Meta + Command. No-op when OpenTUI/chrome/id is missing. */
export function openExternalInspector(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentExternalInspectorOptions,
): ModalHandle | undefined {
  return presentExternalInspector(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

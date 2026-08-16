// Subagent inspector + clickable sidebar list (flow 162).
// Presentation only: the store owns session state. TUI open goes through
// `openModal` from `./modal-host`. No private overlay.

import { openModal } from "./modal-host";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import {
  formatSubagentListHeader,
  formatSubagentMeta,
  formatSubagentRow,
  formatSubagentWork,
  type SubagentSession,
  type SubagentSessionStore,
  type SubagentStoreHint,
} from "./subagent-session";

export const SUBAGENT_INSPECTOR_FOOTER = [
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

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

export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

export type PresentSubagentInspectorOptions = {
  store: SubagentSessionStore;
  id: string;
  renderer?: unknown;
};

type TextNode = { content: string };

type OtuiLike = {
  TextRenderable?: new (renderer: unknown, opts: { id: string; content: string; onMouseDown?: () => void }) => TextNode;
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

function paintContent(otui: unknown, renderer: unknown, body: unknown, content: string): TextNode | undefined {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return undefined;
  }
  const parent = body as { add?: (child: unknown) => void };
  const textCtor = (otui as OtuiLike).TextRenderable;
  if (parent.add === undefined || textCtor === undefined) {
    return undefined;
  }
  const scrollCtor = (otui as OtuiLike).ScrollBoxRenderable;
  let target: { add?: (child: unknown) => void } = parent;
  if (scrollCtor !== undefined) {
    const scroll = new scrollCtor(renderer, {
      id: "subagent-inspector-scroll",
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: { flexDirection: "column" },
    });
    parent.add(scroll);
    if (scroll.content !== undefined) {
      target = scroll.content;
    }
  }
  if (target.add === undefined) {
    return undefined;
  }
  const node = new textCtor(renderer, { id: "subagent-inspector-body", content });
  target.add(node);
  return node;
}

export function inspectorTitle(session: SubagentSession): string {
  const model = session.model !== undefined && session.model.length > 0 ? ` · ${session.model}` : "";
  return `${session.label}${model}`;
}

export function presentSubagentInspector(
  openModalFn: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentSubagentInspectorOptions,
): ModalHandle | undefined {
  const session = options.store.get(options.id);
  if (session === undefined) {
    return undefined;
  }

  let workNode: TextNode | undefined;
  let metaNode: TextNode | undefined;
  let unsubscribe: (() => void) | undefined;

  const refresh = (hint?: SubagentStoreHint): void => {
    if (hint !== undefined && hint.id !== options.id) {
      return;
    }
    const current = options.store.get(options.id);
    if (current === undefined) {
      return;
    }
    if (workNode !== undefined) {
      workNode.content = formatSubagentWork(current);
    }
    if (metaNode !== undefined) {
      metaNode.content = formatSubagentMeta(current);
    }
  };

  const handle = openModalFn(otui, chrome, {
    title: inspectorTitle(session),
    tabs: [
      { id: "work", label: "Work" },
      { id: "meta", label: "Meta" },
    ],
    initialTab: "work",
    footer: SUBAGENT_INSPECTOR_FOOTER,
    renderTab: (tabId, body) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const current = options.store.get(options.id);
      if (current === undefined) {
        paintContent(otui, renderer, body, "Subagent is gone.");
        return;
      }
      if (tabId === "meta") {
        metaNode = paintContent(otui, renderer, body, formatSubagentMeta(current));
        return;
      }
      workNode = paintContent(otui, renderer, body, formatSubagentWork(current));
    },
    onClose: () => {
      unsubscribe?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  unsubscribe = options.store.subscribe(refresh);
  return handle;
}

/** Open the shared host on Work + Meta. No-op when OpenTUI/chrome/id is missing. */
export function openSubagentInspector(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentSubagentInspectorOptions,
): ModalHandle | undefined {
  return presentSubagentInspector(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

export type PaintSubagentSidebarOptions = {
  width?: number;
  onOpen: (id: string) => void;
};

type SidebarParent = {
  add?: (child: unknown) => void;
  getChildren?: () => unknown[];
  remove?: (child: unknown) => void;
};

/** Rebuild the clickable Subagents list. Each row opens the inspector. */
export function paintSubagentSidebar(
  otui: unknown,
  renderer: unknown,
  parent: unknown,
  sessions: readonly SubagentSession[],
  options: PaintSubagentSidebarOptions,
): void {
  const box = parent as SidebarParent;
  const ctor = (otui as OtuiLike).TextRenderable;
  if (box.add === undefined || ctor === undefined) {
    return;
  }
  if (box.getChildren !== undefined && box.remove !== undefined) {
    for (const child of [...box.getChildren()]) {
      box.remove(child);
    }
  }
  if (sessions.length === 0) {
    return;
  }
  const width = options.width ?? SIDEBAR_TEXT_WIDTH;
  box.add(
    new ctor(renderer, {
      id: "sb-subagents-h",
      content: formatSubagentListHeader(sessions.length),
    }),
  );
  for (const session of sessions) {
    const id = session.id;
    box.add(
      new ctor(renderer, {
        id: `sb-sub-${id}`,
        content: formatSubagentRow(session, width),
        onMouseDown: () => {
          options.onOpen(id);
        },
      }),
    );
  }
}

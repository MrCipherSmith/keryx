// /workspace inspector: overview tab + slates list tab + slate detail tab.
// Mirrors flow-inspector.ts's injectable-core/thin-wrapper split and its
// list+detail interaction model (arrows/[ ]/enter, ↑/↓ scroll the active
// tab), extended to a third tab.
//
// Tab-3 "closes" on leaving it (per the design ask): `renderTab`'s cleanup
// callback — called by modal-host when a tab UNMOUNTS, i.e. exactly when the
// user navigates away from "detail" — clears the selected slate, so
// returning to "Slates" and then back to "Detail" without a fresh
// Enter/click shows "No slate selected" again, not stale content.

import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { sortSlatesNewestFirst, type SlateInspectorItem, type WorkspaceInfo } from "./inspector-sources";

export const WORKSPACE_COMMAND = "/workspace";

export const WORKSPACE_FOOTER = [
  { key: "[/]", label: "slate" },
  { key: "↑/↓", label: "scroll" },
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

export function isWorkspaceCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === WORKSPACE_COMMAND;
}

export function formatWorkspaceOverviewLines(workspace: WorkspaceInfo, slateCount: number): string[] {
  const resourceLines =
    workspace.resources.length === 0
      ? ["  (no resources)"]
      : workspace.resources.map((resource) => `  ${resource.kind.padEnd(10)} ${resource.uri}`);
  return [
    `${workspace.id}  ${workspace.title}`,
    `Status   ${workspace.status}`,
    `Slates   ${slateCount}`,
    "",
    "Resources",
    ...resourceLines,
  ];
}

export function formatSlateListLines(items: readonly SlateInspectorItem[], selected: number): string[] {
  if (items.length === 0) {
    return ["No slates bound to this workspace yet."];
  }
  return items.map((item, index) => {
    const mark = index === selected ? ">" : " ";
    const flow = item.flowRef !== undefined ? `flow ${item.flowRef}` : "no flow";
    return `${mark} ${item.sessionId.slice(0, 8)}  ${item.courseStatus.padEnd(8)}  ${item.seedCount} seeds  ${flow}  ${item.sessionTitle}`;
  });
}

export function formatSlateDetailLines(item: SlateInspectorItem | undefined): string[] {
  if (item === undefined) {
    return ["No slate selected.", "", "Press Enter (or click a row) on the Slates tab to view one."];
  }
  const touchedLines = item.touchedFiles.length === 0 ? ["  (none)"] : item.touchedFiles.map((file) => `  ${file}`);
  const seedLines =
    item.seeds.length === 0
      ? ["  (no seeds)"]
      : item.seeds.map((seed) => `  ${seed.ts}  ${(seed.kind ?? "note").padEnd(14)} ${seed.text}`);
  return [
    `${item.sessionId}  ${item.sessionTitle}`,
    `Course   ${item.courseStatus}`,
    `Flow     ${item.flowRef ?? "—"}`,
    `Updated  ${item.updatedAt}`,
    "",
    "Touched files",
    ...touchedLines,
    "",
    "Seeds",
    ...seedLines,
  ];
}

export function clampScroll(offset: number, lineCount: number, height: number): number {
  const max = Math.max(0, lineCount - height);
  return Math.min(max, Math.max(0, offset));
}

export function windowLines(lines: readonly string[], offset: number, height: number): string[] {
  if (height < 1) {
    return [];
  }
  const start = clampScroll(offset, lines.length, height);
  return lines.slice(start, start + height);
}

export function scrollToReveal(index: number, offset: number, height: number): number {
  if (index < offset) {
    return index;
  }
  if (index >= offset + height) {
    return index - height + 1;
  }
  return offset;
}

function wrapLines(text: string, width: number | undefined): string {
  if (width === undefined || width < 8) {
    return text;
  }
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) {
        return [line];
      }
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += width) {
        chunks.push(line.slice(i, i + width));
      }
      return chunks;
    })
    .join("\n");
}

function paintLines(
  otui: unknown,
  renderer: unknown,
  body: unknown,
  lines: readonly string[],
  width?: number,
  idPrefix = "workspace",
): { content: string } | undefined {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return undefined;
  }
  const parent = body as { add?: (child: unknown) => void };
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } })
    .TextRenderable;
  if (parent.add === undefined || ctor === undefined) {
    return undefined;
  }
  const node = new ctor(renderer, { id: `${idPrefix}-body`, content: wrapLines(lines.join("\n"), width) });
  parent.add(node);
  return node;
}

export type PresentWorkspaceOptions = {
  workspace: WorkspaceInfo;
  slates: readonly SlateInspectorItem[];
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

export function presentWorkspace(
  openModal: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentWorkspaceOptions,
): ModalHandle | undefined {
  const items = sortSlatesNewestFirst(options.slates);
  let selected = 0;
  /** `undefined` until a slate is opened; cleared whenever "detail" unmounts (see module docstring). */
  let openIndex: number | undefined;
  let overviewScroll = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let overviewNode: { content: string } | undefined;
  let listNode: { content: string } | undefined;
  let detailNode: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);
  let tabWidth: number | undefined;

  const overviewLines = (): string[] => wrapLines(formatWorkspaceOverviewLines(options.workspace, items.length).join("\n"), tabWidth).split("\n");
  // List rows are item-indexed (mirrors flow-inspector.ts) — unwrapped.
  const listLines = (): string[] => formatSlateListLines(items, selected);
  const detailLines = (): string[] => {
    const item = openIndex !== undefined ? items[openIndex] : undefined;
    return wrapLines(formatSlateDetailLines(item).join("\n"), tabWidth).split("\n");
  };

  const paintSelection = (): void => {
    listScroll = scrollToReveal(selected, listScroll, bodyRows);
    listScroll = clampScroll(listScroll, items.length, bodyRows);
    detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
    overviewScroll = clampScroll(overviewScroll, overviewLines().length, bodyRows);
    if (overviewNode !== undefined) {
      overviewNode.content = windowLines(overviewLines(), overviewScroll, bodyRows).join("\n");
    }
    if (listNode !== undefined) {
      listNode.content = windowLines(listLines(), listScroll, bodyRows).join("\n");
    }
    if (detailNode !== undefined) {
      detailNode.content = windowLines(detailLines(), detailScroll, bodyRows).join("\n");
    }
  };

  const moveSelection = (next: number): void => {
    if (items.length === 0) {
      return;
    }
    const clamped = Math.min(items.length - 1, Math.max(0, next));
    if (clamped === selected) {
      return;
    }
    selected = clamped;
    paintSelection();
  };

  const openSelected = (): void => {
    if (items.length === 0) {
      return;
    }
    openIndex = selected;
    detailScroll = 0;
    handle?.setTab("detail");
    paintSelection();
  };

  const handle = openModal(otui, chrome, {
    title: WORKSPACE_COMMAND,
    tabs: [
      { id: "overview", label: "Workspace" },
      { id: "slates", label: "Slates" },
      { id: "detail", label: "Slate" },
    ],
    initialTab: "overview",
    footer: WORKSPACE_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      tabWidth = ctx?.width;
      if (tabId === "overview") {
        overviewScroll = clampScroll(overviewScroll, overviewLines().length, bodyRows);
        overviewNode = paintLines(otui, renderer, body, windowLines(overviewLines(), overviewScroll, bodyRows), undefined, "workspace-overview");
        return;
      }
      if (tabId === "slates") {
        listScroll = scrollToReveal(selected, listScroll, bodyRows);
        listNode = paintLines(otui, renderer, body, windowLines(listLines(), listScroll, bodyRows), undefined, "workspace-slates");
        return;
      }
      detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
      detailNode = paintLines(otui, renderer, body, windowLines(detailLines(), detailScroll, bodyRows), tabWidth, "workspace-detail");
      // Fires when this tab UNMOUNTS (navigated away from) — clears the open
      // slate so a later return to "Slate" without a fresh selection shows
      // "No slate selected" rather than stale content (the "tab 3 closes"
      // behavior this module's docstring describes).
      return () => {
        openIndex = undefined;
      };
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      const active = handle.activeTab();
      if (active === "slates") {
        if (token === "[" || token === "p" || token === "up" || token === "k") {
          moveSelection(selected - 1);
          return;
        }
        if (token === "]" || token === "n" || token === "down" || token === "j") {
          moveSelection(selected + 1);
          return;
        }
        if (token === "return" || token === "enter") {
          openSelected();
        }
        return;
      }
      const scrollable = active === "detail" ? detailLines : overviewLines;
      const setScroll = (value: number): void => {
        if (active === "detail") {
          detailScroll = value;
        } else {
          overviewScroll = value;
        }
      };
      const current = active === "detail" ? detailScroll : overviewScroll;
      if (token === "up" || token === "k") {
        setScroll(clampScroll(current - 1, scrollable().length, bodyRows));
        paintSelection();
        return;
      }
      if (token === "down" || token === "j") {
        setScroll(clampScroll(current + 1, scrollable().length, bodyRows));
        paintSelection();
        return;
      }
      if (token === "pageup" || token === "pagedown") {
        const step = token === "pageup" ? -bodyRows : bodyRows;
        setScroll(clampScroll(current + step, scrollable().length, bodyRows));
        paintSelection();
      }
    });
  }
  return handle;
}

export function openWorkspace(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentWorkspaceOptions,
): ModalHandle | undefined {
  return presentWorkspace(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

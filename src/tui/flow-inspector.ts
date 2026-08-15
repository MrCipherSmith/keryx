// /flows inspector: list tab + adjacent detail tab.
// Newest flow first. `[`/`]` switch flows; ↑/↓ scroll the active tab body.

import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { sortFlowsNewestFirst, type FlowInspectorItem } from "./inspector-sources";

export const FLOWS_COMMAND = "/flows";

export const FLOWS_FOOTER = [
  { key: "[/]", label: "flow" },
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
  renderTab: (tabId: string, body: unknown) => void | (() => void);
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

export function isFlowsCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === FLOWS_COMMAND;
}

export function findFlowItem(
  items: readonly FlowInspectorItem[],
  query: string,
): FlowInspectorItem | undefined {
  const needle = query.trim();
  if (needle.length === 0) {
    return undefined;
  }
  const padded = /^\d+$/.test(needle) ? needle.padStart(3, "0") : needle;
  return (
    items.find((item) => item.id === needle || item.id === padded || item.dir === needle || item.dir.endsWith(`/${needle}`)) ??
    items.find((item) => item.slug === needle)
  );
}

export function formatFlowListLines(items: readonly FlowInspectorItem[], selected: number): string[] {
  if (items.length === 0) {
    return ["No flows in this project."];
  }
  return items.map((item, index) => {
    const mark = index === selected ? ">" : " ";
    return `${mark} ${item.id}  ${item.status}  ${item.tasksDone}/${item.tasksTotal}  ${item.title}`;
  });
}

export function formatFlowDetailLines(item: FlowInspectorItem): string[] {
  const taskLines =
    item.tasks.length === 0
      ? ["  (no tasks)"]
      : item.tasks.map((task) => `  ${task.id}  ${task.status}  ${task.title}`);
  return [
    `${item.id}  ${item.title}`,
    `Status   ${item.status}`,
    `Dir      ${item.dir}`,
    `Tasks    ${item.tasksDone}/${item.tasksTotal}`,
    `PR       ${item.prUrl ?? "—"}`,
    `Source   ${item.source}`,
    `Created  ${item.createdAt}`,
    `Updated  ${item.updatedAt}`,
    "",
    "Tasks",
    ...taskLines,
  ];
}

export function formatFlowListText(items: readonly FlowInspectorItem[]): string {
  const ordered = sortFlowsNewestFirst(items);
  if (ordered.length === 0) {
    return "Flows\n  No flows in this project.\n";
  }
  return [
    "Flows",
    ...ordered.map((item) => `  ${item.id}  ${item.status}  ${item.tasksDone}/${item.tasksTotal}  ${item.title}`),
    "",
  ].join("\n");
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

export function formatFlowDetailText(item: FlowInspectorItem): string {
  return `${formatFlowDetailLines(item).join("\n")}\n`;
}

export type PresentFlowsOptions = {
  items: readonly FlowInspectorItem[];
  renderer?: { width?: number; height?: number; copyToClipboardOSC52?: (text: string) => void };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

function paintLines(otui: unknown, renderer: unknown, body: unknown, lines: readonly string[]): { content: string } | undefined {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return undefined;
  }
  const parent = body as { add?: (child: unknown) => void };
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } })
    .TextRenderable;
  if (parent.add === undefined || ctor === undefined) {
    return undefined;
  }
  const node = new ctor(renderer, { id: "flows-body", content: lines.join("\n") });
  parent.add(node);
  return node;
}

export function presentFlows(
  openModal: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentFlowsOptions,
): ModalHandle | undefined {
  const items = sortFlowsNewestFirst(options.items);
  let selected = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let listNode: { content: string } | undefined;
  let detailNode: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);

  const listLines = (): string[] => formatFlowListLines(items, selected);
  const detailLines = (): string[] => {
    const item = items[selected];
    return item !== undefined ? formatFlowDetailLines(item) : ["No flow selected."];
  };

  const paintSelection = (): void => {
    listScroll = scrollToReveal(selected, listScroll, bodyRows);
    listScroll = clampScroll(listScroll, items.length, bodyRows);
    detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
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
    detailScroll = 0;
    paintSelection();
  };

  const handle = openModal(otui, chrome, {
    title: "/flows",
    tabs: [
      { id: "list", label: "Flows" },
      { id: "detail", label: "Detail" },
    ],
    initialTab: "list",
    footer: FLOWS_FOOTER,
    renderTab: (tabId, body) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      if (tabId === "list") {
        listScroll = scrollToReveal(selected, listScroll, bodyRows);
        listNode = paintLines(otui, renderer, body, windowLines(listLines(), listScroll, bodyRows));
        return;
      }
      detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
      detailNode = paintLines(otui, renderer, body, windowLines(detailLines(), detailScroll, bodyRows));
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
      if (items.length === 0) {
        return;
      }
      if (token === "[" || token === "p") {
        moveSelection(selected - 1);
        return;
      }
      if (token === "]" || token === "n") {
        moveSelection(selected + 1);
        return;
      }
      if (token === "return" || token === "enter") {
        handle.setTab("detail");
        return;
      }
      const onDetail = handle.activeTab() === "detail";
      if (token === "up" || token === "k") {
        if (onDetail) {
          detailScroll = clampScroll(detailScroll - 1, detailLines().length, bodyRows);
          paintSelection();
        } else {
          moveSelection(selected - 1);
        }
        return;
      }
      if (token === "down" || token === "j") {
        if (onDetail) {
          detailScroll = clampScroll(detailScroll + 1, detailLines().length, bodyRows);
          paintSelection();
        } else {
          moveSelection(selected + 1);
        }
        return;
      }
      if (onDetail && (token === "pageup" || token === "pagedown")) {
        const step = token === "pageup" ? -bodyRows : bodyRows;
        detailScroll = clampScroll(detailScroll + step, detailLines().length, bodyRows);
        paintSelection();
      }
    });
  }
  return handle;
}

export function openFlows(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentFlowsOptions,
): ModalHandle | undefined {
  return presentFlows(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

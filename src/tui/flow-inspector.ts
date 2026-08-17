// /flows inspector: list tab + adjacent detail tab. Selection is ↑/↓; → opens Detail.

import { openModal } from "./modal-host";
import type { FlowInspectorItem } from "./inspector-sources";

export const FLOWS_COMMAND = "/flows";

export const FLOWS_FOOTER = [
  { key: "↑/↓", label: "select" },
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
  if (items.length === 0) {
    return "Flows\n  No flows in this project.\n";
  }
  return [
    "Flows",
    ...items.map((item) => `  ${item.id}  ${item.status}  ${item.tasksDone}/${item.tasksTotal}  ${item.title}`),
    "",
  ].join("\n");
}

export function formatFlowDetailText(item: FlowInspectorItem): string {
  return `${formatFlowDetailLines(item).join("\n")}\n`;
}

export type PresentFlowsOptions = {
  items: readonly FlowInspectorItem[];
  renderer?: { copyToClipboardOSC52?: (text: string) => void };
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

// Review finding: session-info.ts's tabs wrap to ctx.width (added in this
// same diff for the new flex-scaling modal panel); this file's tabs never
// picked up the equivalent plumbing, so /flows content overflows unwrapped
// on a narrow terminal while /status wraps correctly right next to it.
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
  const node = new ctor(renderer, { id: "flows-body", content: wrapLines(lines.join("\n"), width) });
  parent.add(node);
  return node;
}

export function presentFlows(
  openModal: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentFlowsOptions,
): ModalHandle | undefined {
  const items = options.items;
  let selected = 0;
  let listNode: { content: string } | undefined;
  let detailNode: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;
  let tabWidth: number | undefined;

  const paintSelection = (): void => {
    if (listNode !== undefined) {
      listNode.content = wrapLines(formatFlowListLines(items, selected).join("\n"), tabWidth);
    }
    if (detailNode !== undefined) {
      const item = items[selected];
      detailNode.content = wrapLines(
        item !== undefined ? formatFlowDetailLines(item).join("\n") : "No flow selected.",
        tabWidth,
      );
    }
  };

  const handle = openModal(otui, chrome, {
    title: "/flows",
    tabs: [
      { id: "list", label: "Flows" },
      { id: "detail", label: "Detail" },
    ],
    initialTab: "list",
    footer: FLOWS_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      tabWidth = ctx?.width;
      if (tabId === "list") {
        listNode = paintLines(otui, renderer, body, formatFlowListLines(items, selected), tabWidth);
        return;
      }
      const item = items[selected];
      detailNode = paintLines(
        otui,
        renderer,
        body,
        item !== undefined ? formatFlowDetailLines(item) : ["No flow selected."],
        tabWidth,
      );
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
      if (token === "up" || token === "k") {
        selected = selected > 0 ? selected - 1 : 0;
        paintSelection();
      } else if (token === "down" || token === "j") {
        selected = selected < items.length - 1 ? selected + 1 : selected;
        paintSelection();
      } else if (token === "return" || token === "enter") {
        handle.setTab("detail");
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

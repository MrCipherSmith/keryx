// /flows inspector: list tab + adjacent detail tab.
// Newest flow first. `[`/`]` switch flows; ↑/↓ scroll the active tab body.

import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { sortFlowsNewestFirst, type AcMarker, type FlowInspectorItem } from "./inspector-sources";

export const FLOWS_COMMAND = "/flows";
/** Flow 328, AC7: `/ac` opens the same modal straight to the AC tab of the current flow. */
export const AC_COMMAND = "/ac";

export const FLOWS_FOOTER = [
  { key: "[/]", label: "flow" },
  { key: "↑/↓", label: "scroll" },
  { key: "←/→", label: "tabs" },
  { key: "c", label: "check AC" },
  { key: "esc", label: "close" },
] as const;

/** Flow 328, AC7: one line per criterion — English, fixed marker glyphs so a screen reader/log reads the same word every time. */
const MARKER_GLYPH: Readonly<Record<AcMarker["status"], string>> = {
  "likely-met": "[met]",
  "not-evident": "[not evident]",
  "not-checkable": "[not checkable]",
};

/** The compact per-criterion summary the list row and the AC tab both use. */
export function formatAcMarkersSummary(item: FlowInspectorItem): string {
  if (item.acMarkers === undefined || item.acMarkers.length === 0) {
    return "AC: not run";
  }
  const counts = item.acMarkers.reduce(
    (acc, marker) => {
      if (marker.status === "likely-met") acc.met += 1;
      else if (marker.status === "not-evident") acc.notEvident += 1;
      else acc.notCheckable += 1;
      return acc;
    },
    { met: 0, notEvident: 0, notCheckable: 0 },
  );
  const staleNote =
    item.acCheckStale === true
      ? " (stale — the criteria or the diff changed since this check)"
      : item.acCheckStale === "unknown"
        ? " (freshness unknown — could not compute the current diff quickly)"
        : "";
  return `AC: ${counts.met} met, ${counts.notEvident} not evident, ${counts.notCheckable} not checkable${staleNote}`;
}

/** Flow 328, AC7: the AC tab's detail lines — per criterion, with evidence when a Jev call produced a probability. */
export function formatAcCheckLines(item: FlowInspectorItem): string[] {
  if (item.acMarkers === undefined || item.acMarkers.length === 0) {
    return ["No acceptance-criteria check has been run for this flow yet.", "Press `c` to run `keryx flow check-ac` now."];
  }
  const freshnessNote =
    item.acCheckStale === true
      ? "  (STALE — the criteria or the diff changed since this check; press `c` to re-check)"
      : item.acCheckStale === "unknown"
        ? "  (FRESHNESS UNKNOWN — could not compute the current diff quickly; press `c` to re-check)"
        : "";
  const lines: string[] = [`Last checked: ${item.acCheckedAt ?? "unknown"}${freshnessNote}`, ""];
  for (const marker of item.acMarkers) {
    lines.push(`${marker.id}  ${MARKER_GLYPH[marker.status]}`);
  }
  lines.push("", "Press `c` to re-check now.");
  return lines;
}

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

/** Flow 328, AC7: `/ac` — an entry point straight to the AC tab of the currently active flow. */
export function isAcCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === AC_COMMAND;
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

/** The status column: `completing (interrupted)` when nothing is running the completion (flow 299). */
function statusCell(item: FlowInspectorItem): string {
  return item.interrupted ? `${item.status} (interrupted)` : item.status;
}

export function formatFlowListLines(items: readonly FlowInspectorItem[], selected: number): string[] {
  if (items.length === 0) {
    return ["No flows in this project."];
  }
  return items.map((item, index) => {
    const mark = index === selected ? ">" : " ";
    return `${mark} ${item.id}  ${statusCell(item)}  ${item.tasksDone}/${item.tasksTotal}  ${item.title}`;
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
    ...(item.interrupted ? [`         ${item.interrupted}`] : []),
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
    ...ordered.map((item) => `  ${item.id}  ${statusCell(item)}  ${item.tasksDone}/${item.tasksTotal}  ${item.title}`),
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
  /** Flow 328, AC7: opens straight to the AC tab, for `/ac`. */
  initialTab?: "list" | "detail" | "ac";
  /**
   * Flow 328, AC7's "a key to run the check": pressing `c` calls this with
   * the currently selected flow. The check itself (git diff, Jev, cache
   * write) is entirely the caller's concern — this modal only asks and
   * displays whatever fresh `items` it is next opened with; it never runs a
   * check itself.
   *
   * Review finding (item 4): returns a `Promise` now, not `void`, so this
   * modal can show an in-progress "Checking…" state on the AC tab and ignore
   * a second `c` while one is in flight — a fire-and-forget callback gave it
   * no way to know when the check was done. On success the caller is
   * expected to replace this modal with a fresh one (fresh `items`, fresh
   * cached markers) the same way it always has; on failure it returns
   * `{error}` instead of reopening, so THIS modal can show the error in
   * place rather than silently closing over it.
   */
  onRunCheck?: (item: FlowInspectorItem) => Promise<{ readonly error?: string } | void>;
};

// Review finding: session-info.ts's tabs wrap to ctx.width (added in this
// same diff for the new flex-scaling modal panel); this file's tabs never
// picked up the equivalent plumbing, so /flows content overflows unwrapped
// on a narrow terminal while /status wraps correctly right next to it.
export function wrapLines(text: string, width: number | undefined): string {
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
  const items = sortFlowsNewestFirst(options.items);
  let selected = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let listNode: { content: string } | undefined;
  let detailNode: { content: string } | undefined;
  let acNode: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);
  let tabWidth: number | undefined;
  // Item 4 review finding: an in-modal busy state for `c` — without it,
  // pressing `c` gave no feedback until the whole modal was replaced (or,
  // on failure, no feedback at all beyond a terminal line that had already
  // scrolled past by the time anyone looked). `checkError` is cleared on
  // every new `c` press, not just on success, so a stale error never lingers
  // once the operator asks for a fresh check.
  let checking = false;
  let checkError: string | undefined;

  // List rows are one line per flow (fixed `id status done/total title`
  // format) and its scroll/selection math is item-indexed (`scrollToReveal`
  // reveals `selected`'s ROW), so it is windowed unwrapped — wrapping would
  // desync the item↔row mapping the moment any title wraps to 2+ lines.
  // Detail's body is prose (summary/tasks) with an already line-offset (not
  // item-indexed) scroll, so wrapping composes there without that hazard —
  // this is the fix for /flows content overflowing unwrapped on a narrow
  // terminal while /status wraps correctly right next to it.
  const listLines = (): string[] => formatFlowListLines(items, selected);
  const detailLines = (): string[] => {
    const item = items[selected];
    const raw = item !== undefined ? formatFlowDetailLines(item) : ["No flow selected."];
    return wrapLines(raw.join("\n"), tabWidth).split("\n");
  };
  const acLines = (): string[] => {
    const item = items[selected];
    if (checking) {
      return ["Checking…", "", "Running `keryx flow check-ac` against the frozen criteria — this can take a few seconds."];
    }
    const raw = item !== undefined ? formatAcCheckLines(item) : ["No flow selected."];
    const withError = checkError !== undefined ? [...raw, "", `Error: ${checkError}`] : raw;
    return wrapLines(withError.join("\n"), tabWidth).split("\n");
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
    if (acNode !== undefined) {
      acNode.content = windowLines(acLines(), 0, bodyRows).join("\n");
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
      { id: "ac", label: "AC" },
    ],
    initialTab: options.initialTab ?? "list",
    footer: FLOWS_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      tabWidth = ctx?.width;
      if (tabId === "list") {
        listScroll = scrollToReveal(selected, listScroll, bodyRows);
        listNode = paintLines(otui, renderer, body, windowLines(listLines(), listScroll, bodyRows));
        return;
      }
      if (tabId === "ac") {
        acNode = paintLines(otui, renderer, body, windowLines(acLines(), 0, bodyRows));
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
      if (token === "c") {
        const item = items[selected];
        // Item 4: ignore `c` while a check is already in flight — a second
        // press must never start a second overlapping check for the same
        // (or a different) flow while the first one's result is still
        // pending.
        if (item !== undefined && options.onRunCheck !== undefined && !checking) {
          checking = true;
          checkError = undefined;
          paintSelection();
          void options
            .onRunCheck(item)
            .then((outcome) => {
              checking = false;
              if (outcome !== undefined && outcome.error !== undefined) {
                // Failure: shown in THIS modal, in place — the caller does
                // not reopen a fresh one, since a failed check produced no
                // new markers to show.
                checkError = outcome.error;
                paintSelection();
              }
              // Success: the caller is expected to replace this modal with
              // a fresh one carrying the newly cached markers. Nothing more
              // to paint here either way.
            })
            .catch((error: unknown) => {
              checking = false;
              checkError = error instanceof Error ? error.message : String(error);
              paintSelection();
            });
        }
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

// `/product` (flow 362): the TUI half of `keryx product open`. One list of the
// intents closed in code that nobody looked back at, under the same header
// `keryx product open` prints — the never-checked count and its three-way
// breakdown — built from the same `openHeaderLines` / `openEntryLines`, so the
// two surfaces never state different numbers.
//
// Read-only. Opening it never rebuilds the index, and it refuses nothing.

import { loadOpenReport, openEntryLines, openHeaderLines, type OpenLoad } from "../product/service";
import { clampScroll, wrapLines, windowLines, type ModalHandle, type OpenModalFn } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";

export const PRODUCT_COMMAND = "/product";

export const PRODUCT_FOOTER = [
  { key: "↑/↓", label: "scroll" },
  { key: "esc", label: "close" },
] as const;

export function isProductCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === PRODUCT_COMMAND;
}

/** The fixed header: the count first, then the breakdown, or the one line that says why there is no count. */
export function formatProductHeaderLines(load: OpenLoad): string[] {
  return load.ok ? openHeaderLines(load.report) : [load.message];
}

/** One block per never-checked intent, a blank line between blocks. */
export function formatProductRowLines(load: OpenLoad): string[] {
  if (!load.ok) return [];
  if (load.report.entries.length === 0) return ["Nothing closed in code is waiting for a look back."];
  return load.report.entries.flatMap((entry) => ["", ...openEntryLines(entry)]);
}

export type PresentProductOptions = {
  load: OpenLoad;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

function paint(otui: unknown, renderer: unknown, body: unknown, content: string): { content: string } | undefined {
  const parent = body as { add?: (child: unknown) => void } | undefined | null;
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } } | undefined | null)
    ?.TextRenderable;
  if (parent?.add === undefined || ctor === undefined) return undefined;
  const node = new ctor(renderer, { id: "product-body", content });
  parent.add(node);
  return node;
}

export function presentProductOpen(
  open: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentProductOptions,
): ModalHandle | undefined {
  const header = formatProductHeaderLines(options.load);
  const rows = formatProductRowLines(options.load);
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);
  const rowWindow = Math.max(1, bodyRows - header.length);
  let scroll = 0;
  let width: number | undefined;
  let node: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;

  const content = (): string => {
    scroll = clampScroll(scroll, rows.length, rowWindow);
    return wrapLines([...header, ...windowLines(rows, scroll, rowWindow)].join("\n"), width);
  };
  const repaint = (): void => {
    if (node !== undefined) node.content = content();
  };

  const handle = open(otui, chrome, {
    title: PRODUCT_COMMAND,
    tabs: [{ id: "open", label: "Never checked" }],
    initialTab: "open",
    footer: PRODUCT_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx?.width;
      node = paint(otui, options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer, body, content());
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) return undefined;
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      const step = token === "up" || token === "k" ? -1 : token === "down" || token === "j" ? 1 : token === "pageup" ? -rowWindow : token === "pagedown" ? rowWindow : 0;
      if (step === 0) return;
      scroll = clampScroll(scroll + step, rows.length, rowWindow);
      repaint();
    });
  }
  return handle;
}

export type OpenProductOptions = Omit<PresentProductOptions, "load"> & { cwd: string };

/** Read the index (never rebuild it) and open the modal over what `keryx product open` would print. */
export async function openProduct(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: OpenProductOptions,
): Promise<ModalHandle | undefined> {
  const { cwd, ...rest } = options;
  const load = await loadOpenReport(cwd);
  return presentProductOpen(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    { ...rest, load },
  );
}

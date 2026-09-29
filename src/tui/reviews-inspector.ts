// `/reviews`: the TUI and readline halves of `keryx review metrics`. The modal, the sidebar row
// and the readline text are all built from one `BotMetrics`, so no surface states a number the
// CLI does not. Read-only: opening it reads the managed review packages and changes nothing.

import { computeBotMetrics, formatRatio, renderBotMetrics, type BotMetrics, type ReviewRow } from "../review/bot/metrics";
import { clampScroll, wrapLines, windowLines, type ModalHandle, type OpenModalFn } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { onThemeChange, type TextRole } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const REVIEWS_COMMAND = "/reviews";
export const REVIEWS_EMPTY = "No managed pull request reviews yet. Run `keryx review bot run --pr <n>`.";

export const REVIEWS_FOOTER = [
  { key: "↑/↓", label: "scroll" },
  { key: "esc", label: "close" },
] as const;

export function isReviewsCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === REVIEWS_COMMAND;
}

export function formatReviewsHeaderLines(metrics: BotMetrics): string[] {
  return [
    `${metrics.reviews} review(s) on ${metrics.pulls} pull request(s); ${metrics.raised} finding(s) raised, ${metrics.open} open`,
    `precision ${formatRatio(metrics.precision)}   resolved before merge ${formatRatio(metrics.resolvedBeforeMerge.ratio)}`,
  ];
}

export function formatReviewRowLines(row: ReviewRow): string[] {
  const resolved = row.resolvedBeforeMerge === null ? "n/a" : `${row.resolvedBeforeMerge} of ${row.findings}`;
  return [
    `${row.pull}  round ${row.round}  head ${row.head === null ? "unknown" : row.head.slice(0, 7)}`,
    `  findings ${row.findings}: acted on ${row.actedOn}, dismissed ${row.dismissed}, answered ${row.answeredDisagree}, open ${row.unknown}`,
    `  precision ${formatRatio(row.precision)}   resolved before merge ${resolved}`,
  ];
}

/** One block per managed review, a blank line between blocks. */
export function formatReviewsRowLines(metrics: BotMetrics): string[] {
  if (metrics.rows.length === 0) return [REVIEWS_EMPTY];
  return metrics.rows.flatMap((row, index) => (index === 0 ? formatReviewRowLines(row) : ["", ...formatReviewRowLines(row)]));
}

/** The readline shell's `/reviews`: the block `keryx review metrics` prints, then the review rows. */
export function renderReviewsText(metrics: BotMetrics): string {
  return `${renderBotMetrics(metrics)}\n${formatReviewsRowLines(metrics).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export type PresentReviewsOptions = {
  metrics: BotMetrics;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

function paint(otui: unknown, renderer: unknown, body: unknown, content: string): { content: string } | undefined {
  const parent = body as { add?: (child: unknown) => void } | undefined | null;
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } } | undefined | null)
    ?.TextRenderable;
  if (parent?.add === undefined || ctor === undefined) return undefined;
  const node = new ctor(renderer, { id: "reviews-body", content });
  parent.add(node);
  return node;
}

export function presentReviews(
  open: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentReviewsOptions,
): ModalHandle | undefined {
  const header = formatReviewsHeaderLines(options.metrics);
  const rows = formatReviewsRowLines(options.metrics);
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
    title: REVIEWS_COMMAND,
    tabs: [{ id: "reviews", label: "Managed reviews" }],
    initialTab: "reviews",
    footer: REVIEWS_FOOTER,
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

export type OpenReviewsOptions = Omit<PresentReviewsOptions, "metrics"> & {
  cwd: string;
  read?: (cwd: string) => Promise<BotMetrics>;
};

/** Read the managed reviews and open the modal over what `keryx review metrics` would print. */
export async function openReviews(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: OpenReviewsOptions,
): Promise<ModalHandle | undefined> {
  const { cwd, read = computeBotMetrics, ...rest } = options;
  const metrics = await read(cwd).catch((): BotMetrics | undefined => undefined);
  if (metrics === undefined) return undefined;
  return presentReviews(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    { ...rest, metrics },
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export type ReviewsRowAction = "open" | "none";

export interface ReviewsRow {
  readonly text: string;
  readonly role: TextRole;
  readonly action: ReviewsRowAction;
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** One value row: the open-findings count, or the one word for why there is none. */
export function projectReviewsRow(metrics: BotMetrics | undefined, width: number, options: { failed?: boolean } = {}): ReviewsRow {
  if (options.failed === true) return { text: fit("unreadable", width), role: "error", action: "none" };
  if (metrics === undefined) return { text: fit("reading reviews…", width), role: "muted", action: "none" };
  if (metrics.reviews === 0) return { text: fit("no reviews yet", width), role: "muted", action: "open" };
  if (metrics.open === 0) return { text: fit("no open findings", width), role: "muted", action: "open" };
  return { text: fit(`${metrics.open} open finding${metrics.open === 1 ? "" : "s"}`, width), role: "attention", action: "open" };
}

type PanelParent = { add(child: unknown): void };
type TextNode = { content: unknown; onMouseDown?: (() => void) | undefined };

export interface ReviewsPanelOptions {
  cwd: string;
  width: number;
  onOpen: () => void;
  /** Injectable for tests. Default `computeBotMetrics`. */
  read?: (cwd: string) => Promise<BotMetrics>;
}

export interface ReviewsPanelHandle {
  refresh(): Promise<void>;
  row(): ReviewsRow;
  activate(): ReviewsRowAction;
  dispose(): void;
}

export function mountReviewsPanel(otui: unknown, renderer: unknown, parent: unknown, options: ReviewsPanelOptions): ReviewsPanelHandle {
  const core = otui as OpenTui;
  const box = new core.BoxRenderable(renderer as never, { id: "sb-reviews", flexDirection: "column", flexShrink: 0 });
  (parent as PanelParent).add(box);
  const read = options.read ?? computeBotMetrics;
  let latest: BotMetrics | undefined;
  let failed = false;
  let generation = 0;
  let disposed = false;

  const label = new core.TextRenderable(renderer as never, {
    id: "sb-reviews-k",
    content: core.t`${dimChunk(core, "Reviews")}`,
    marginTop: 1,
  });
  const value = new core.TextRenderable(renderer as never, { id: "sb-reviews-v", content: "" }) as unknown as TextNode;
  box.add(label);
  box.add(value as never);

  const currentRow = (): ReviewsRow => projectReviewsRow(latest, options.width, { failed });
  const draw = (): void => {
    if (disposed) return;
    const row = currentRow();
    label.content = core.t`${dimChunk(core, "Reviews")}`;
    value.content = core.t`${roleChunk(core, row.role, row.text)}`;
  };
  const activate = (): ReviewsRowAction => {
    const action = currentRow().action;
    if (action === "open") options.onOpen();
    return action;
  };
  label.onMouseDown = () => {
    activate();
  };
  value.onMouseDown = () => {
    activate();
  };

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    let next: BotMetrics | undefined;
    let unreadable = false;
    try {
      next = await read(options.cwd);
    } catch {
      unreadable = true;
    }
    if (disposed || mine !== generation) return;
    failed = unreadable;
    if (next !== undefined) latest = next;
    draw();
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("reviews-panel", draw, () => disposed || isRenderableGone(box)));
  draw();
  void refresh();

  return {
    refresh,
    row: currentRow,
    activate,
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribeTheme();
    },
  };
}

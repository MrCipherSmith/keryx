// `/reviews`: the TUI and readline halves of `keryx review metrics`. The modal, the sidebar row
// and the readline text are all built from one `BotMetrics`, so no surface states a number the
// CLI does not. Read-only: opening it reads the managed review packages and changes nothing.

import { paritySummary } from "../review/parity";
import { memoryLogNote } from "../review/readiness";
import { formatReviewDepthLines, layersLine, loadReviewDepth, renderReviewDegradationText, renderReviewDepthText, renderReviewLayersText, renderReviewParityText, renderReviewReadinessText, type ReviewDepthRow } from "./review-panel";
import { createReviewLayersActions, type ReviewLayersActions } from "./review-layers-actions";
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

export const REVIEWS_ACTIONS_FOOTER = [
  { key: "↑/↓", label: "scroll" },
  { key: "l", label: "refresh layers" },
  { key: "c", label: "prepare missing chunks" },
  { key: "esc", label: "close" },
] as const;

/** `/review layers`: the layers of every managed review, as text. The bare `/review` stays the catch-up inspector. */
export function isReviewLayersCommand(line: string): boolean {
  const [token, sub] = line.trim().split(/\s+/);
  return token === "/review" && sub === "layers";
}

/** `/review parity`: Not run candidates, held severities and open follow-ups of every managed review, as text. */
export function isReviewParityCommand(line: string): boolean {
  const [token, sub] = line.trim().split(/\s+/);
  return token === "/review" && sub === "parity";
}

/** `/review readiness`: the readiness checklist of every managed review, as text. */
export function isReviewReadinessCommand(line: string): boolean {
  const [token, sub] = line.trim().split(/\s+/);
  return token === "/review" && sub === "readiness";
}

export { renderReviewDegradationText, renderReviewLayersText, renderReviewParityText, renderReviewReadinessText };

/** The sidebar's Readiness block: per review, the verdict and the failing item ids, wrapped to the sidebar width. */
export function projectReviewsReadinessLines(depth: readonly ReviewDepthRow[] | undefined, width: number, limit = 3): string[] {
  if (depth === undefined) return [];
  return depth
    .filter((row) => row.readiness !== undefined)
    .slice(0, limit)
    .map((row) => {
      const report = row.readiness!;
      const failing = report.items.filter((item) => item.status === "fail").map((item) => item.id);
      const verdict = failing.length === 0 ? `${row.reviewId}: ${report.verdict}` : `${row.reviewId}: ${report.verdict}, ${failing.join(", ")}`;
      const note = memoryLogNote(report);
      return wrapLines(note === "" ? verdict : `${verdict} (${note})`, width);
    });
}

/** One sidebar line per review that left something behind: `Not run 3, held 1, follow-ups 2`, wrapped to the sidebar width. */
export function projectReviewsParityLines(depth: readonly ReviewDepthRow[] | undefined, width: number, limit = 3): string[] {
  if (depth === undefined) return [];
  return depth
    .map((row) => paritySummary(row.parity))
    .filter((line) => line !== "")
    .slice(0, limit)
    .map((line) => line.split(", ").map((part) => wrapLines(part, width)).join("\n"));
}

/** One sidebar line per review that has anything to say about its layers, wrapped to the sidebar width. */
export function projectReviewsLayerLines(depth: readonly ReviewDepthRow[] | undefined, width: number, limit = 3): string[] {
  if (depth === undefined) return [];
  return depth
    .filter((row) => row.layersView !== undefined && (row.layersView.layers !== null || row.layersView.usage !== null || row.layersView.chunks !== null))
    .slice(0, limit)
    .map((row) => layersLine(row.layersView).split("; ").map((part) => wrapLines(part, width)).join("\n"));
}

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
export function renderReviewsText(metrics: BotMetrics, depth?: readonly ReviewDepthRow[]): string {
  const base = `${renderBotMetrics(metrics)}\n${formatReviewsRowLines(metrics).join("\n")}\n`;
  return depth === undefined ? base : `${base}\n${renderReviewDepthText(depth)}`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export type PresentReviewsOptions = {
  metrics: BotMetrics;
  /** What each review ran (mode, reviewer set, mutation); adds the "Review depth" tab. */
  depth?: readonly ReviewDepthRow[];
  /** The menu actions on the newest review: `l` refreshes its layers, `c` prepares its missing chunks. */
  actions?: ReviewLayersActions;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

function paint(otui: unknown, renderer: unknown, body: unknown, content: string, id: string): { content: string } | undefined {
  const parent = body as { add?: (child: unknown) => void } | undefined | null;
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } } | undefined | null)
    ?.TextRenderable;
  if (parent?.add === undefined || ctor === undefined) return undefined;
  const node = new ctor(renderer, { id, content });
  parent.add(node);
  return node;
}

type TabView = { rows: string[]; header: string[]; scroll: number; node: { content: string } | undefined };

// Module level: a modal reopened while its action still runs must not start a second one for the same package.
const pendingActions = new Set<string>();

export function presentReviews(
  open: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentReviewsOptions,
): ModalHandle | undefined {
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);
  const views: Record<string, TabView> = {
    reviews: { header: formatReviewsHeaderLines(options.metrics), rows: formatReviewsRowLines(options.metrics), scroll: 0, node: undefined },
  };
  const tabs = [{ id: "reviews", label: "Managed reviews" }];
  if (options.depth !== undefined) {
    views.depth = { header: [], rows: formatReviewDepthLines(options.depth), scroll: 0, node: undefined };
    if (options.actions !== undefined) views.depth.header = ["actions: l refresh layers, c prepare missing chunks (newest review)"];
    tabs.push({ id: "depth", label: "Review depth" });
  }
  const windowOf = (view: TabView): number => Math.max(1, bodyRows - view.header.length);
  let width: number | undefined;
  let unsubscribeKey: (() => void) | undefined;
  let active = "reviews";

  const content = (view: TabView): string => {
    view.scroll = clampScroll(view.scroll, view.rows.length, windowOf(view));
    return wrapLines([...view.header, ...windowLines(view.rows, view.scroll, windowOf(view))].join("\n"), width);
  };

  const handle = open(otui, chrome, {
    title: REVIEWS_COMMAND,
    tabs,
    initialTab: "reviews",
    footer: options.actions !== undefined && options.depth !== undefined ? REVIEWS_ACTIONS_FOOTER : REVIEWS_FOOTER,
    renderTab: (tabId, body, ctx) => {
      width = ctx?.width;
      active = tabId;
      const view = views[tabId];
      if (view === undefined) return;
      view.node = paint(otui, options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer, body, content(view), `reviews-${tabId}-body`);
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) return undefined;
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      const view = views[handle.activeTab() || active];
      if (view === undefined) return;
      const newest = options.depth?.[0];
      if ((token === "l" || token === "c") && options.actions !== undefined && newest !== undefined && views.depth !== undefined) {
        const depthView = views.depth;
        const actionKey = newest.layersView?.dir ?? newest.reviewId;
        if (pendingActions.has(actionKey)) {
          depthView.header = [`${newest.reviewId}: still working, wait for it to finish…`];
          if (depthView.node !== undefined) depthView.node.content = content(depthView);
          return;
        }
        pendingActions.add(actionKey);
        const run = token === "l" ? options.actions.refreshLayers(newest) : options.actions.runMissingChunks(newest);
        depthView.header = [token === "l" ? "refreshing layers…" : "estimating chunks…"];
        void run
          .catch((error: unknown) => `Action failed for ${newest.reviewId}: ${error instanceof Error ? error.message : String(error)}`)
          .then((message) => {
            pendingActions.delete(actionKey);
            depthView.header = message.split("\n");
            if (depthView.node !== undefined) depthView.node.content = content(depthView);
          });
        if (depthView.node !== undefined) depthView.node.content = content(depthView);
        return;
      }
      const rowWindow = windowOf(view);
      const step = token === "up" || token === "k" ? -1 : token === "down" || token === "j" ? 1 : token === "pageup" ? -rowWindow : token === "pagedown" ? rowWindow : 0;
      if (step === 0) return;
      view.scroll = clampScroll(view.scroll + step, view.rows.length, rowWindow);
      if (view.node !== undefined) view.node.content = content(view);
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
  const depth = await loadReviewDepth(cwd).catch((): ReviewDepthRow[] | undefined => undefined);
  return presentReviews(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    { actions: createReviewLayersActions(cwd), ...rest, metrics, ...(depth !== undefined ? { depth } : {}) },
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
  /** Injectable for tests. Default `loadReviewDepth`. */
  readDepth?: (cwd: string) => Promise<ReviewDepthRow[]>;
}

export interface ReviewsPanelHandle {
  refresh(): Promise<void>;
  row(): ReviewsRow;
  activate(): ReviewsRowAction;
  /** The per-review layer lines the sidebar paints under the count. */
  layerLines(): string[];
  /** The per-review leftovers (Not run, held, follow-ups) the sidebar paints under the layer lines. */
  parityLines(): string[];
  /** The Readiness block: verdict and failing items per review. */
  readinessLines(): string[];
  /** Managed reviews whose readiness verdict is NOT READY (the Reviews card's attention signal). */
  notReadyCount(): number;
  dispose(): void;
}

export function mountReviewsPanel(otui: unknown, renderer: unknown, parent: unknown, options: ReviewsPanelOptions): ReviewsPanelHandle {
  const core = otui as OpenTui;
  const box = new core.BoxRenderable(renderer as never, { id: "sb-reviews", flexDirection: "column", flexShrink: 0 });
  (parent as PanelParent).add(box);
  const read = options.read ?? computeBotMetrics;
  const readDepth = options.readDepth ?? loadReviewDepth;
  let depth: ReviewDepthRow[] | undefined;
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
  const layerNode = new core.TextRenderable(renderer as never, { id: "sb-reviews-layers", content: "" }) as unknown as TextNode;
  box.add(layerNode as never);
  const parityNode = new core.TextRenderable(renderer as never, { id: "sb-reviews-parity", content: "" }) as unknown as TextNode;
  box.add(parityNode as never);
  const readinessNode = new core.TextRenderable(renderer as never, { id: "sb-reviews-readiness", content: "" }) as unknown as TextNode;
  box.add(readinessNode as never);

  const currentRow = (): ReviewsRow => projectReviewsRow(latest, options.width, { failed });
  const draw = (): void => {
    if (disposed) return;
    const row = currentRow();
    label.content = core.t`${dimChunk(core, "Reviews")}`;
    value.content = core.t`${roleChunk(core, row.role, row.text)}`;
    layerNode.content = projectReviewsLayerLines(depth, options.width).join("\n");
    parityNode.content = projectReviewsParityLines(depth, options.width).join("\n");
    readinessNode.content = projectReviewsReadinessLines(depth, options.width).join("\n");
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
    depth = await readDepth(options.cwd).catch((): ReviewDepthRow[] | undefined => undefined);
    if (disposed || mine !== generation) return;
    draw();
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("reviews-panel", draw, () => disposed || isRenderableGone(box)));
  draw();
  void refresh();

  return {
    refresh,
    row: currentRow,
    activate,
    layerLines: () => projectReviewsLayerLines(depth, options.width),
    parityLines: () => projectReviewsParityLines(depth, options.width),
    readinessLines: () => projectReviewsReadinessLines(depth, options.width),
    notReadyCount: () => depth?.filter((row) => row.readiness?.verdict === "NOT READY").length ?? 0,
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribeTheme();
    },
  };
}

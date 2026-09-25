// Flow 306 (AC12): the `/ci` modal — failed CI runs/jobs of the current
// branch's PR, each with its triage verdict and per-option probabilities, and
// a job's own detail. Follows the list+detail shape `triggers-inspector.ts`
// established, trimmed of run-now/arm (triage has nothing to confirm; it is a
// read plus one advisory-only model call, never a rerun/status-check/merge).
//
// Nothing here spends anything on open: a job starts "not triaged yet" and is
// only sent to Jev when the operator presses `t` — the standing opt-in/cost
// discipline (AC10/AC11) extends to the TUI surface, not only the CLI.

import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { CI_TRIAGE_CRITERIA, renderCiTriageAdvisory, type CiTriageVerdict } from "../review/ci-triage";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const CI_TRIAGE_COMMAND = "/ci";

export function isCiTriageCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === CI_TRIAGE_COMMAND;
}

export const CI_TRIAGE_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter", label: "detail" },
  { key: "t", label: "triage" },
  { key: "esc", label: "close" },
] as const;

export interface CiTriageJobItem {
  readonly runId: string;
  readonly jobName: string;
  readonly workflowName: string;
  readonly headBranch: string;
  readonly conclusion: string | null;
  readonly createdAt?: string | null;
}

export interface CiTriageListRead {
  readonly items: readonly CiTriageJobItem[];
  /** Why the list is empty (not enabled, no PR, no failed runs, ...), when `items` is. */
  readonly note?: string;
}

export type CiTriageRunResult =
  | { readonly ok: true; readonly verdict: CiTriageVerdict; readonly testName?: string }
  | { readonly ok: false; readonly reason: string };

type ItemState =
  | { readonly kind: "idle" }
  | { readonly kind: "triaging" }
  | { readonly kind: "done"; readonly verdict: CiTriageVerdict; readonly testName?: string }
  | { readonly kind: "error"; readonly reason: string };

function itemKey(item: CiTriageJobItem): string {
  return `${item.runId}:${item.jobName}`;
}

export interface CiTriageModalOptions {
  cwd: string;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  load: (cwd: string) => Promise<CiTriageListRead>;
  triage: (cwd: string, item: CiTriageJobItem) => Promise<CiTriageRunResult>;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  /**
   * True while a composer choice or a permission prompt owns the keyboard
   * (review F11 elsewhere): the modal then ignores keys. Default:
   * `chrome.keyboardOwnedElsewhere()`.
   */
  inputBlocked?: () => boolean;
}

export interface CiTriageModalHandle extends ModalHandle {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  visibleLines(): readonly string[];
  selected(): CiTriageJobItem | undefined;
  /** Settles once an in-flight `t` triage has recorded its outcome (tests). */
  settled(): Promise<void>;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function stateSummary(state: ItemState): string {
  if (state.kind === "idle") return "not triaged — press t";
  if (state.kind === "triaging") return "triaging…";
  if (state.kind === "error") return `error: ${state.reason}`;
  return `${state.verdict.top} ${pct(state.verdict.topProbability)} (advisory)`;
}

export function formatCiTriageListLines(
  items: readonly CiTriageJobItem[],
  states: ReadonlyMap<string, ItemState>,
  selected: number,
): string[] {
  if (items.length === 0) {
    return ["No failed CI runs found for the current branch's pull request."];
  }
  return items.map((item, index) => {
    const mark = index === selected ? ">" : " ";
    const age = item.createdAt !== undefined && item.createdAt !== null ? ` ${item.createdAt}` : "";
    const state = states.get(itemKey(item)) ?? { kind: "idle" as const };
    return `${mark} ${item.jobName}  [${item.conclusion ?? "unknown"}]  run ${item.runId}  ${item.workflowName}/${item.headBranch}${age}  —  ${stateSummary(state)}`;
  });
}

export function formatCiTriageDetailLines(item: CiTriageJobItem | undefined, state: ItemState | undefined): string[] {
  if (item === undefined) return ["No job selected."];
  const s = state ?? { kind: "idle" as const };
  if (s.kind === "idle") return [`${item.jobName} (run ${item.runId}) has not been triaged yet.`, "", "Press t to triage — this sends a redacted, bounded log excerpt to OpenRouter/TypeSafe."];
  if (s.kind === "triaging") return [`Triaging ${item.jobName} (run ${item.runId})…`];
  if (s.kind === "error") return [`Could not triage ${item.jobName} (run ${item.runId}):`, "", s.reason];
  return renderCiTriageAdvisory({
    runId: item.runId,
    jobName: item.jobName,
    ...(s.testName !== undefined ? { testName: s.testName } : {}),
    verdict: s.verdict,
  }).split("\n");
}

export function openCiTriage(otui: unknown, chrome: unknown, options: CiTriageModalOptions): CiTriageModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let read: CiTriageListRead = { items: [] };
  const states = new Map<string, ItemState>();
  let selected = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let width: number | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const selectedItem = (): CiTriageJobItem | undefined => read.items[selected];
  const activeTab = (): string => host.handle?.activeTab() ?? "list";
  const listLines = (): string[] =>
    read.note !== undefined && read.items.length === 0 ? [read.note] : formatCiTriageListLines(read.items, states, selected);
  const detailLines = (): string[] => {
    const item = selectedItem();
    return wrapLines(formatCiTriageDetailLines(item, item === undefined ? undefined : states.get(itemKey(item))).join("\n"), width).split(
      "\n",
    );
  };
  const visible = (): string[] =>
    activeTab() === "detail" ? windowLines(detailLines(), detailScroll, bodyRows) : windowLines(listLines(), listScroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    listScroll = clampScroll(scrollToReveal(selected, listScroll, bodyRows), listLines().length, bodyRows);
    detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };

  const reload = async (): Promise<void> => {
    read = await options.load(options.cwd);
    selected = Math.min(selected, Math.max(0, read.items.length - 1));
    paint();
  };

  const runTriage = (item: CiTriageJobItem): void => {
    const key = itemKey(item);
    states.set(key, { kind: "triaging" });
    paint();
    inFlight = options.triage(options.cwd, item).then((result) => {
      states.set(
        key,
        result.ok ? { kind: "done", verdict: result.verdict, ...(result.testName !== undefined ? { testName: result.testName } : {}) } : { kind: "error", reason: result.reason },
      );
      paint();
    });
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: CI_TRIAGE_COMMAND,
    tabs: [
      { id: "list", label: "Runs" },
      { id: "detail", label: "Detail" },
    ],
    footer: CI_TRIAGE_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "ci-triage-body", content: "" }) as never;
      parent.add(bodyNode);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  const modal = handle;
  host.handle = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "ci-triage-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    const onDetail = modal.activeTab() === "detail";
    const move = (next: number): void => {
      const clamped = Math.min(Math.max(0, read.items.length - 1), Math.max(0, next));
      if (clamped !== selected) {
        selected = clamped;
        detailScroll = 0;
      }
    };
    if (token === "t") {
      const item = selectedItem();
      if (item !== undefined) runTriage(item);
    } else if (token === "return" || token === "enter") {
      modal.setTab("detail");
    } else if (token === "up" || token === "k") {
      if (onDetail) detailScroll = clampScroll(detailScroll - 1, detailLines().length, bodyRows);
      else move(selected - 1);
    } else if (token === "down" || token === "j") {
      if (onDetail) detailScroll = clampScroll(detailScroll + 1, detailLines().length, bodyRows);
      else move(selected + 1);
    } else if (onDetail && (token === "pageup" || token === "pagedown")) {
      detailScroll = clampScroll(detailScroll + (token === "pageup" ? -bodyRows : bodyRows), detailLines().length, bodyRows);
    } else {
      return;
    }
    paint();
  });

  const ready = reload();
  return {
    ...modal,
    ready,
    reload,
    visibleLines: visible,
    selected: selectedItem,
    settled: () => inFlight,
  };
}

/** Re-exported for tests/docs that want the criterion order without re-importing `../review/ci-triage`. */
export const CI_TRIAGE_VERDICT_CRITERIA = CI_TRIAGE_CRITERIA;

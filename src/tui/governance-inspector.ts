// Flow 300 T6 (AC3), flow 364 (AC3, AC5-AC7): the governance report modal.
//
// Two tabs under one fixed header (generated_at, filters, all_projects of the
// STORED report, or the run in flight):
//
// - Flows (flow 364): the current project's flows, open first, each with its
//   summary and stated effect. ↑/↓/j/k select. `c` runs the read-only
//   completion check for the selected open flow; once a check passed on a
//   merged PR, `d` asks for the flow id typed back and then runs the real
//   `flow complete`, and the report is re-run so the list shows the result.
// - Report: the stored `latest.md`, wrapped to the panel width and windowed the
//   way `/flows` windows its detail tab: ↑/↓/j/k one line, PgUp/PgDn one page,
//   clamped so the last line is reachable.
//
// `r` re-runs the report in the background through the same runner the
// sidebar uses; the open modal re-reads and repaints when that run finishes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FlowCompleteResult, FlowCompletionCheck } from "../flow/types";
import {
  governanceDataRoot,
  readLatestGovernanceReport,
  renderGovernanceMarkdown,
  type FlowGovernance,
  type GovernanceReportRead,
} from "../governance/service";
import { clampScroll, windowLines, wrapLines } from "./flow-inspector";
import { createGovernanceFlowActions, type GovernanceFlowActions } from "./governance-flow-actions";
import { closeOffer, flowEntriesFrom, formatActionLine, formatFlowEntryLines, wrapHanging, type CloseOffer } from "./governance-flows";
import { formatReportDate, type GovernanceRunner } from "./governance-panel";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const GOVERNANCE_COMMAND = "/governance";

export const GOVERNANCE_FOOTER = [
  { key: "↑/↓", label: "select" },
  { key: "c", label: "check" },
  // Not `x`: modal-host closes the modal on `x`.
  { key: "d", label: "complete" },
  { key: "r", label: "re-run" },
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

/** Text rows the fixed header may take. */
const HEADER_TEXT_ROWS = 2;
/** Rows the fixed header takes above the scrolled body: its text plus the body's top margin. */
export const GOVERNANCE_HEADER_ROWS = HEADER_TEXT_ROWS + 1;
/** Rows the Flows tab's action row takes below the list: a top margin plus the row. */
export const GOVERNANCE_ACTION_ROWS = 2;

export type GovernanceTab = "flows" | "report";

export interface GovernanceModalOptions {
  cwd: string;
  runner: GovernanceRunner;
  renderer?: { width?: number; height?: number };
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  /** Injectable for tests. */
  readLatest?: (cwd: string) => Promise<GovernanceReportRead>;
  /** Injectable for tests. Default: `latest.md` beside `latest.json`. */
  readMarkdown?: (cwd: string) => Promise<string | undefined>;
  /** Override the body height (tests). */
  visibleRows?: number;
  /**
   * True while a composer choice or a permission prompt owns the keyboard
   * (review F11): the modal then ignores keys, so an `r` or `y` meant for that
   * prompt never re-runs, checks or closes anything here.
   */
  inputBlocked?: () => boolean;
  /** Flow 364: check and close. Default: the real flow service in `cwd`. */
  flowActions?: GovernanceFlowActions;
  /** Default `flows`. */
  initialTab?: GovernanceTab;
}

export interface GovernanceModalHandle extends ModalHandle {
  /** The Report tab's lines currently visible (tests). */
  visibleLines(): readonly string[];
  /** Every Report tab line, wrapped to the panel width (tests). */
  allLines(): readonly string[];
  /** The Flows tab's lines currently visible (tests). */
  visibleFlowLines(): readonly string[];
  /** Every Flows tab line, wrapped to the panel width (tests). */
  allFlowLines(): readonly string[];
  /** The Flows tab's action row (tests). */
  actionLine(): string;
  /** The selected flow's id, if any (tests). */
  selectedFlowId(): string | undefined;
  /** What close is offered for the selected flow (tests). */
  selectedCloseOffer(): CloseOffer | undefined;
  /** The header text (tests). */
  header(): string;
  /** Re-read the stored report and repaint (after an outside write). */
  reload(): Promise<void>;
  /** Settles once the initial read has painted. */
  readonly ready: Promise<void>;
  /** Settles when the check or close in flight (if any) has finished and painted (tests). */
  settled(): Promise<void>;
}

export function governanceMarkdownPath(cwd: string): string {
  return path.join(governanceDataRoot(cwd), "artifacts", "latest.md");
}

async function defaultReadMarkdown(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(governanceMarkdownPath(cwd), "utf8");
  } catch {
    return undefined;
  }
}

function filtersText(filters: Record<string, unknown>): string {
  return (
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ") || "none"
  );
}

type TextNode = { content: unknown; onMouseDown?: (() => void) | undefined };

export function openGovernanceReport(
  otui: unknown,
  chrome: unknown,
  options: GovernanceModalOptions,
): GovernanceModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const readLatest = options.readLatest ?? readLatestGovernanceReport;
  const readMarkdown = options.readMarkdown ?? defaultReadMarkdown;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, (options.visibleRows ?? panelRows) - GOVERNANCE_HEADER_ROWS);
  const listRows = Math.max(1, bodyRows - GOVERNANCE_ACTION_ROWS);
  let actions: GovernanceFlowActions | undefined = options.flowActions;
  const flowActions = (): GovernanceFlowActions => (actions ??= createGovernanceFlowActions(options.cwd));

  let read: GovernanceReportRead | undefined;
  let markdown: string | undefined;
  let scroll = 0;
  let listScroll = 0;
  let width: number | undefined;
  let headerNode: TextNode | undefined;
  let bodyNode: TextNode | undefined;
  let listNode: TextNode | undefined;
  let actionNode: TextNode | undefined;
  let closed = false;
  // Filled once the modal is open; `onClose` (which can run first) reads it.
  const keys: { off?: () => void } = {};

  // Flows tab state, keyed by flow id so a reload keeps what was learned.
  let selectedId: string | undefined;
  const checks = new Map<string, FlowCompletionCheck>();
  const closeResults = new Map<string, Pick<FlowCompleteResult, "passed" | "gates">>();
  const errors = new Map<string, string>();
  let checkingId: string | undefined;
  let closingId: string | undefined;
  let confirming: { id: string; typed: string; branch: string | undefined } | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const unavailableLines = (): string[] | undefined => {
    if (read === undefined) return ["Reading the stored report…"];
    if (read.state === "absent") return ["No governance report yet. Press r to run one in the background."];
    if (read.state === "malformed") {
      return [`Stored governance report is unreadable (${read.reason}).`, "Press r to run a new one — it rewrites it."];
    }
    return undefined;
  };

  const bodyLines = (): string[] => {
    const unavailable = unavailableLines();
    if (unavailable !== undefined || read?.state !== "present") return unavailable ?? [];
    const text = markdown ?? renderGovernanceMarkdown(read.report);
    return wrapLines(text.replace(/\n+$/, ""), width).split("\n");
  };

  const flows = (): FlowGovernance[] => (read?.state === "present" ? flowEntriesFrom(read.report, options.cwd).flows : []);
  const selectedIndex = (): number => {
    const list = flows();
    const index = list.findIndex((flow) => flow.id === selectedId);
    return index === -1 ? 0 : index;
  };
  const selectedFlow = (): FlowGovernance | undefined => flows()[selectedIndex()];
  const offerFor = (flow: FlowGovernance | undefined): CloseOffer | undefined =>
    flow === undefined ? undefined : closeOffer(flow, checks.get(flow.id));

  /** The Flows tab's lines, plus where the selected entry starts and ends. */
  const flowView = (): { lines: string[]; start: number; end: number } => {
    const unavailable = unavailableLines();
    if (unavailable !== undefined || read?.state !== "present") return { lines: unavailable ?? [], start: 0, end: 0 };
    const { flows: list, note } = flowEntriesFrom(read.report, options.cwd);
    if (note !== undefined) return { lines: [note], start: 0, end: 0 };
    const chosen = selectedIndex();
    const lines: string[] = [];
    let start = 0;
    let end = 0;
    list.forEach((flow, index) => {
      if (index === chosen) start = lines.length;
      const entry = formatFlowEntryLines(flow, {
        selected: index === chosen,
        check: checks.get(flow.id),
        checking: checkingId === flow.id,
        closing: closingId === flow.id,
        closeResult: closeResults.get(flow.id),
        error: errors.get(flow.id),
      });
      lines.push(...entry.flatMap((line) => wrapHanging(line, width)));
      if (index === chosen) end = lines.length - 1;
    });
    return { lines, start, end };
  };
  /** Keep the selected entry's first line on screen, and as much of the rest as fits. */
  const revealSelection = (): void => {
    const { lines, start, end } = flowView();
    if (start < listScroll) listScroll = start;
    else if (end >= listScroll + listRows) listScroll = Math.min(start, end - listRows + 1);
    listScroll = clampScroll(listScroll, lines.length, listRows);
  };
  const actionLine = (): string => {
    if (read?.state !== "present") return "";
    const flow = selectedFlow();
    return formatActionLine(flow, offerFor(flow), confirming);
  };

  const headerText = (): string => {
    const run = options.runner.state();
    const runNote =
      run.kind === "running" ? " · running…" : run.kind === "failed" ? ` · last run failed: ${run.reason}` : "";
    if (read?.state !== "present") return `no stored report${runNote}`;
    const report = read.report;
    return `generated_at ${formatReportDate(report.generatedAt)} · filters ${filtersText(report.filters)} · all_projects ${report.allProjects}${runNote}`;
  };
  const visible = (): string[] => windowLines(bodyLines(), scroll, bodyRows);
  const visibleFlows = (): string[] => windowLines(flowView().lines, listScroll, listRows);
  const paint = (): void => {
    if (closed) return;
    scroll = clampScroll(scroll, bodyLines().length, bodyRows);
    listScroll = clampScroll(listScroll, flowView().lines.length, listRows);
    if (headerNode !== undefined) {
      const text = wrapLines(headerText(), width).split("\n").slice(0, HEADER_TEXT_ROWS).join("\n");
      headerNode.content = core.t`${dimChunk(core, text)}`;
    }
    if (bodyNode !== undefined) bodyNode.content = core.t`${roleChunk(core, "text", visible().join("\n"))}`;
    if (listNode !== undefined) listNode.content = core.t`${roleChunk(core, "text", visibleFlows().join("\n"))}`;
    if (actionNode !== undefined) {
      const offer = offerFor(selectedFlow());
      const role = confirming !== undefined ? "attention" : offer?.kind === "close" ? "accent" : "muted";
      actionNode.content = core.t`${roleChunk(core, role, wrapLines(actionLine(), width).split("\n")[0] ?? "")}`;
    }
  };
  const reload = async (): Promise<void> => {
    const [nextRead, nextMd] = await Promise.all([
      readLatest(options.cwd).catch((error: unknown): GovernanceReportRead => ({
        state: "malformed",
        reason: error instanceof Error ? error.message : String(error),
      })),
      readMarkdown(options.cwd),
    ]);
    read = nextRead;
    markdown = nextRead.state === "present" ? nextMd : undefined;
    revealSelection();
    paint();
  };

  // --- Flows tab actions --------------------------------------------------

  const runCheck = (): void => {
    const flow = selectedFlow();
    if (flow === undefined || flow.status === "done" || checkingId !== undefined || closingId !== undefined) return;
    const id = flow.id;
    checkingId = id;
    errors.delete(id);
    paint();
    inFlight = flowActions()
      .check(id)
      .then((check) => {
        checks.set(id, check);
      })
      .catch((error: unknown) => {
        errors.set(id, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        checkingId = undefined;
        revealSelection();
        paint();
      });
  };

  const beginClose = (): void => {
    const flow = selectedFlow();
    if (flow === undefined || offerFor(flow)?.kind !== "close" || closingId !== undefined || checkingId !== undefined) return;
    const id = flow.id;
    confirming = { id, typed: "", branch: undefined };
    paint();
    void flowActions()
      .branch()
      .then((branch) => {
        if (confirming?.id === id) {
          confirming = { ...confirming, branch };
          paint();
        }
      })
      .catch(() => {});
  };

  const runClose = (id: string): void => {
    const offeredOn = checks.get(id);
    const flow = flows().find((candidate) => candidate.id === id);
    if (offeredOn === undefined || flow === undefined) {
      // The confirmation is already gone; say why nothing happened.
      if (flow !== undefined) errors.set(id, "not completed: press c to check again first");
      paint();
      return;
    }
    closingId = id;
    errors.delete(id);
    closeResults.delete(id);
    paint();
    // Review L-003: the offer was made on a check and the stored report, and
    // either can be stale by now. Check again against the live flow first;
    // complete only when nothing changed since and the offer still stands.
    const actions = flowActions();
    inFlight = actions
      .check(id)
      .then(async (fresh) => {
        checks.set(id, fresh);
        if (fresh.updatedAt !== offeredOn.updatedAt || closeOffer(flow, fresh).kind !== "close") {
          errors.set(id, "not completed: the flow changed or no longer passes since the check — the new check is shown");
          return;
        }
        const result = await actions.close(id);
        closeResults.set(id, { passed: result.passed, gates: result.gates });
        // Whatever happened, the check it was offered on is spent.
        checks.delete(id);
      })
      .catch((error: unknown) => {
        errors.set(id, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        closingId = undefined;
        revealSelection();
        paint();
        // AC7: the list shows the flow's new state once the report is rebuilt.
        void options.runner.start();
      });
  };

  /** While a close confirmation is open, every key belongs to it. */
  const confirmKey = (token: string, sequence: string): void => {
    if (confirming === undefined) return;
    if (token === "return" || token === "enter") {
      const { id, typed } = confirming;
      confirming = undefined;
      if (typed === id) runClose(id);
      else paint();
      return;
    }
    if (token === "backspace") {
      confirming = { ...confirming, typed: confirming.typed.slice(0, -1) };
      paint();
      return;
    }
    if (/^[0-9]$/.test(sequence) && confirming.typed.length < confirming.id.length) {
      confirming = { ...confirming, typed: confirming.typed + sequence };
      paint();
      return;
    }
    confirming = undefined;
    paint();
  };

  const moveSelection = (delta: number): void => {
    const list = flows();
    if (list.length === 0) return;
    const next = Math.min(list.length - 1, Math.max(0, selectedIndex() + delta));
    selectedId = list[next]?.id;
    revealSelection();
    paint();
  };

  let unsubscribeTheme: () => void = () => {};
  const unsubscribeRunner = options.runner.subscribe((_state, event) => {
    if (event === "finished") {
      scroll = 0;
      void reload();
    } else {
      paint();
    }
  });
  const handle = openModal(core, chrome as never, {
    title: GOVERNANCE_COMMAND,
    tabs: [
      { id: "flows", label: "Flows" },
      { id: "report", label: "Report" },
    ],
    initialTab: options.initialTab ?? "flows",
    footer: GOVERNANCE_FOOTER,
    // Review L-001: while the flow id is being typed, every key but Escape is
    // the confirmation's — digits must not jump tabs, `x` must not close the
    // modal. A blocked keyboard claims nothing, so the prompt that owns it
    // still gets its keys.
    claimKey: (key) => {
      if (closed || confirming === undefined || options.inputBlocked?.() === true) return false;
      confirmKey(key.name || key.sequence, key.sequence);
      return true;
    },
    renderTab: (tabId, body, ctx) => {
      width = ctx.width;
      // Leaving the Flows tab (a tab-strip click, or a key while the keyboard
      // is blocked) cancels a pending confirmation rather than hiding it there.
      // A re-mount of the Flows tab itself — a theme change does that — keeps it.
      if (tabId !== "flows") confirming = undefined;
      const parent = body as { add(child: unknown): void };
      headerNode = new core.TextRenderable(r as never, { id: "gov-header", content: "" }) as never;
      parent.add(headerNode);
      if (tabId === "report") {
        bodyNode = new core.TextRenderable(r as never, { id: "gov-body", content: "", marginTop: 1 }) as never;
        parent.add(bodyNode);
      } else {
        const list = new core.TextRenderable(r as never, { id: "gov-flows", content: "", marginTop: 1 }) as unknown as TextNode;
        const action = new core.TextRenderable(r as never, { id: "gov-actions", content: "", marginTop: 1 }) as unknown as TextNode;
        // AC5: the action row is clickable — a click does what its key does.
        action.onMouseDown = () => {
          if (closed || options.inputBlocked?.() === true || confirming !== undefined) return;
          if (offerFor(selectedFlow())?.kind === "close") beginClose();
          else runCheck();
        };
        parent.add(list);
        parent.add(action);
        listNode = list;
        actionNode = action;
      }
      revealSelection();
      paint();
      return () => {
        headerNode = undefined;
        bodyNode = undefined;
        listNode = undefined;
        actionNode = undefined;
      };
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeRunner();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) {
    unsubscribeRunner();
    return undefined;
  }
  // Subscribed only once the modal really opened (review F13).
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "governance-modal",
      paint,
      () => closed || isRenderableGone(headerNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (confirming !== undefined) {
      confirmKey(token, key.sequence);
      return;
    }
    if (token === "r") {
      void options.runner.start();
      paint();
      return;
    }
    if (handle.activeTab() === "flows") {
      if (token === "up" || token === "k") moveSelection(-1);
      else if (token === "down" || token === "j") moveSelection(1);
      else if (token === "pageup") moveSelection(-Math.max(1, Math.floor(listRows / 3)));
      else if (token === "pagedown") moveSelection(Math.max(1, Math.floor(listRows / 3)));
      else if (token === "home") moveSelection(-flows().length);
      else if (token === "end") moveSelection(flows().length);
      else if (token === "c") runCheck();
      else if (token === "d") beginClose();
      return;
    }
    const total = bodyLines().length;
    if (token === "up" || token === "k") scroll = clampScroll(scroll - 1, total, bodyRows);
    else if (token === "down" || token === "j") scroll = clampScroll(scroll + 1, total, bodyRows);
    else if (token === "pageup") scroll = clampScroll(scroll - bodyRows, total, bodyRows);
    else if (token === "pagedown") scroll = clampScroll(scroll + bodyRows, total, bodyRows);
    else if (token === "home") scroll = 0;
    else if (token === "end") scroll = clampScroll(total, total, bodyRows);
    else return;
    paint();
  });

  const ready = reload();
  return {
    ...handle,
    visibleLines: visible,
    allLines: bodyLines,
    visibleFlowLines: visibleFlows,
    allFlowLines: () => flowView().lines,
    actionLine,
    selectedFlowId: () => selectedFlow()?.id,
    selectedCloseOffer: () => offerFor(selectedFlow()),
    header: headerText,
    reload,
    ready,
    settled: () => inFlight,
  };
}

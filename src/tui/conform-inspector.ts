// Flow 308 (AC8): the `/conform` modal — pick a reference document (recent
// ones remembered) and a target (the current branch's PR, a review package,
// or the working diff), then a list of clauses grouped by kind with status
// and a detail view with evidence and the explanation. Follows the list+
// detail shape `ci-triage-inspector.ts` established (flow 306) — this file
// is a SEPARATE module, not an edit to that one, because a parallel flow
// (307) is also editing `src/tui/ci-triage-*`.
//
// Nothing here spends anything on open: the reference document and target
// are picked first, and the actual conformance run (the Jev calls) happens
// only once the operator presses `enter` on a target — the same standing
// opt-in/cost discipline the CLI's own AC9 gate applies.

import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const CONFORM_COMMAND = "/conform";

export function isConformCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === CONFORM_COMMAND;
}

export const CONFORM_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter", label: "pick / run / detail" },
  { key: "tab", label: "setup ↔ clauses" },
  { key: "esc", label: "close" },
] as const;

export type ConformTargetKind = "pr" | "report" | "diff";

export interface ConformTargetOption {
  readonly id: string;
  readonly kind: ConformTargetKind;
  readonly label: string;
}

export interface ConformSetupRead {
  readonly recents: readonly string[];
  readonly targets: readonly ConformTargetOption[];
  /** Why no target is available (conform disabled for this project, no credential), when there is none. */
  readonly note?: string;
}

export type ConformClauseStatus = "satisfied" | "likely-violated" | "not-checkable" | "not-evaluated";

export interface ConformClauseRow {
  readonly clause_id: string;
  readonly state_kind: "pr" | "report" | "hunk";
  readonly status: ConformClauseStatus;
  readonly probability?: number;
  readonly reason?: string;
  readonly evidence: readonly string[];
  readonly explanation?: string;
}

export type ConformRunOutcome =
  | { readonly ok: true; readonly refPath: string; readonly target: ConformTargetOption; readonly clauses: readonly ConformClauseRow[] }
  | { readonly ok: false; readonly reason: string };

export interface ConformModalOptions {
  cwd: string;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  loadSetup: (cwd: string) => Promise<ConformSetupRead>;
  run: (cwd: string, refPath: string, target: ConformTargetOption, signal?: AbortSignal) => Promise<ConformRunOutcome>;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  /** True while a composer choice or a permission prompt owns the keyboard (review F11 elsewhere). Default: `chrome.keyboardOwnedElsewhere()`. */
  inputBlocked?: () => boolean;
}

export interface ConformModalHandle extends ModalHandle {
  readonly ready: Promise<void>;
  visibleLines(): readonly string[];
  settled(): Promise<void>;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const STATUS_LABEL: Readonly<Record<ConformClauseStatus, string>> = {
  satisfied: "satisfied",
  "likely-violated": "likely violated",
  "not-checkable": "not checkable",
  "not-evaluated": "not evaluated",
};

/** AC8: the Setup tab — recent docs, then targets, one flat navigable list. */
export function formatConformSetupLines(
  setup: ConformSetupRead,
  selectedDocIndex: number | undefined,
  cursor: number,
): string[] {
  const lines: string[] = [];
  if (setup.recents.length === 0) {
    lines.push("(no recent reference documents — type one at the prompt, or pass --ref on the CLI first)");
  } else {
    lines.push("Reference documents (recent):");
    setup.recents.forEach((doc, i) => {
      const mark = i === cursor ? ">" : " ";
      const picked = i === selectedDocIndex ? "[x]" : "[ ]";
      lines.push(`${mark} ${picked} ${doc}`);
    });
  }
  lines.push("");
  if (setup.note !== undefined) {
    lines.push(setup.note);
    return lines;
  }
  lines.push("Target:");
  setup.targets.forEach((target, i) => {
    const rowIndex = setup.recents.length + i;
    const mark = rowIndex === cursor ? ">" : " ";
    lines.push(`${mark} ${target.label}`);
  });
  if (selectedDocIndex === undefined) {
    lines.push("", "Pick a reference document above first, then enter on a target to run.");
  } else {
    lines.push("", `Reference document: ${setup.recents[selectedDocIndex]}`, "Press enter on a target to run.");
  }
  return lines;
}

function statusSummary(row: ConformClauseRow): string {
  if (row.status === "not-checkable") return `not checkable — ${row.reason ?? "no reason recorded"}`;
  if (row.status === "not-evaluated") return "not evaluated — no state supplied this run";
  if (row.probability === undefined) return STATUS_LABEL[row.status];
  return `${STATUS_LABEL[row.status]} (${pct(row.probability)})`;
}

/** AC8: clauses grouped by kind with status. */
export function formatConformClauseLines(clauses: readonly ConformClauseRow[], selected: number): string[] {
  if (clauses.length === 0) {
    return ["No clauses in this reference document."];
  }
  const lines: string[] = [];
  let lastKind: string | undefined;
  let index = 0;
  for (const kind of ["pr", "report", "hunk"] as const) {
    const inKind = clauses.filter((c) => c.state_kind === kind);
    if (inKind.length === 0) continue;
    if (lastKind !== undefined) lines.push("");
    lines.push(`-- ${kind} --`);
    lastKind = kind;
    for (const row of inKind) {
      const mark = index === selected ? ">" : " ";
      lines.push(`${mark} ${row.clause_id}  ${statusSummary(row)}`);
      index += 1;
    }
  }
  return lines;
}

/** The clauses in the SAME flattened order `formatConformClauseLines` walks — what `selected` indexes into. */
export function flattenConformClauses(clauses: readonly ConformClauseRow[]): readonly ConformClauseRow[] {
  return (["pr", "report", "hunk"] as const).flatMap((kind) => clauses.filter((c) => c.state_kind === kind));
}

/** AC8: a detail view with evidence and the explanation. */
export function formatConformDetailLines(row: ConformClauseRow | undefined): string[] {
  if (row === undefined) return ["No clause selected."];
  const lines: string[] = [`${row.clause_id} (${row.state_kind}) — ${statusSummary(row)}`, ""];
  if (row.evidence.length > 0) {
    lines.push("evidence:");
    for (const fact of row.evidence) lines.push(`  - ${fact}`);
  }
  if (row.explanation !== undefined) {
    lines.push("", "explanation (ADVISORY — not written to the PR or to findings.json):", row.explanation);
  }
  return lines;
}

export function openConform(otui: unknown, chrome: unknown, options: ConformModalOptions): ConformModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let setup: ConformSetupRead = { recents: [], targets: [] };
  let selectedDocIndex: number | undefined;
  let setupCursor = 0;
  let clauses: readonly ConformClauseRow[] = [];
  let clauseSelected = 0;
  let runError: string | undefined;
  let running = false;
  let listScroll = 0;
  let detailScroll = 0;
  let width: number | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  let controller: AbortController | undefined;
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const activeTab = (): string => host.handle?.activeTab() ?? "setup";
  const flat = (): readonly ConformClauseRow[] => flattenConformClauses(clauses);
  const clauseLines = (): string[] => {
    if (running) return ["Running conformance check…"];
    if (runError !== undefined) return [`Could not run: ${runError}`];
    return formatConformClauseLines(clauses, clauseSelected);
  };
  const detailLines = (): string[] => formatConformDetailLines(flat()[clauseSelected]);
  const setupLines = (): string[] => formatConformSetupLines(setup, selectedDocIndex, setupCursor);

  const currentLines = (): string[] => {
    const tab = activeTab();
    if (tab === "setup") return setupLines();
    if (tab === "detail") return wrapLines(detailLines().join("\n"), width).split("\n");
    return clauseLines();
  };
  const visible = (): string[] => {
    const tab = activeTab();
    if (tab === "detail") return windowLines(currentLines(), detailScroll, bodyRows);
    return windowLines(currentLines(), listScroll, bodyRows);
  };
  const paint = (): void => {
    if (closed) return;
    const tab = activeTab();
    if (tab === "setup") {
      listScroll = clampScroll(scrollToReveal(setupCursor, listScroll, bodyRows), currentLines().length, bodyRows);
    } else if (tab === "clauses") {
      listScroll = clampScroll(scrollToReveal(clauseSelected, listScroll, bodyRows), currentLines().length, bodyRows);
    } else {
      detailScroll = clampScroll(detailScroll, currentLines().length, bodyRows);
    }
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, visible().join("\n"))}`;
  };

  const reloadSetup = async (): Promise<void> => {
    setup = await options.loadSetup(options.cwd);
    paint();
  };

  const runConform = (target: ConformTargetOption): void => {
    if (selectedDocIndex === undefined) return;
    const refPath = setup.recents[selectedDocIndex];
    if (refPath === undefined) return;
    controller?.abort();
    controller = new AbortController();
    running = true;
    runError = undefined;
    host.handle?.setTab("clauses");
    paint();
    inFlight = options.run(options.cwd, refPath, target, controller.signal).then((outcome) => {
      if (closed) return;
      running = false;
      if (outcome.ok) {
        clauses = outcome.clauses;
        clauseSelected = 0;
        runError = undefined;
      } else {
        runError = outcome.reason;
      }
      paint();
    });
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: CONFORM_COMMAND,
    tabs: [
      { id: "setup", label: "Setup" },
      { id: "clauses", label: "Clauses" },
      { id: "detail", label: "Detail" },
    ],
    footer: CONFORM_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "conform-body", content: "" }) as never;
      parent.add(bodyNode);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
      controller?.abort();
    },
  });
  if (handle === undefined) return undefined;
  const modal = handle;
  host.handle = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "conform-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    const tab = activeTab();
    if (token === "tab") {
      modal.setTab(tab === "setup" ? "clauses" : tab === "clauses" ? "detail" : "setup");
      paint();
      return;
    }
    if (tab === "setup") {
      const rowCount = setup.recents.length + setup.targets.length;
      if (token === "up" || token === "k") {
        setupCursor = Math.max(0, setupCursor - 1);
      } else if (token === "down" || token === "j") {
        setupCursor = Math.min(Math.max(0, rowCount - 1), setupCursor + 1);
      } else if (token === "return" || token === "enter") {
        if (setupCursor < setup.recents.length) {
          selectedDocIndex = setupCursor;
        } else {
          const target = setup.targets[setupCursor - setup.recents.length];
          if (target !== undefined) runConform(target);
        }
      } else {
        return;
      }
    } else if (tab === "clauses") {
      if (token === "up" || token === "k") {
        clauseSelected = Math.max(0, clauseSelected - 1);
      } else if (token === "down" || token === "j") {
        clauseSelected = Math.min(Math.max(0, flat().length - 1), clauseSelected + 1);
      } else if (token === "return" || token === "enter") {
        modal.setTab("detail");
      } else {
        return;
      }
    } else {
      if (token === "up" || token === "k") {
        detailScroll = clampScroll(detailScroll - 1, currentLines().length, bodyRows);
      } else if (token === "down" || token === "j") {
        detailScroll = clampScroll(detailScroll + 1, currentLines().length, bodyRows);
      } else if (token === "pageup" || token === "pagedown") {
        detailScroll = clampScroll(detailScroll + (token === "pageup" ? -bodyRows : bodyRows), currentLines().length, bodyRows);
      } else {
        return;
      }
    }
    paint();
  });

  const ready = reloadSetup();
  return {
    ...modal,
    ready,
    visibleLines: visible,
    settled: () => inFlight,
  };
}

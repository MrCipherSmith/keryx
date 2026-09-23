// Flow 300 T6 (AC3): the governance report modal.
//
// One tab. A fixed header (generated_at, filters, all_projects of the STORED
// report, or the run in flight) over the stored `latest.md`, wrapped to the
// panel width and windowed the way `/flows` windows its detail tab:
// ↑/↓/j/k one line, PgUp/PgDn one page, clamped so the last line is reachable.
// `r` re-runs the report in the background through the same runner the
// sidebar uses; the open modal re-reads and repaints when that run finishes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  governanceDataRoot,
  readLatestGovernanceReport,
  renderGovernanceMarkdown,
  type GovernanceReportRead,
} from "../governance/service";
import { clampScroll, windowLines, wrapLines } from "./flow-inspector";
import { formatReportDate, type GovernanceRunner } from "./governance-panel";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const GOVERNANCE_COMMAND = "/governance";

export const GOVERNANCE_FOOTER = [
  { key: "↑/↓ j/k", label: "scroll" },
  { key: "PgUp/PgDn", label: "page" },
  { key: "r", label: "re-run" },
  { key: "esc", label: "close" },
] as const;

/** Text rows the fixed header may take. */
const HEADER_TEXT_ROWS = 2;
/** Rows the fixed header takes above the scrolled body: its text plus the body's top margin. */
export const GOVERNANCE_HEADER_ROWS = HEADER_TEXT_ROWS + 1;

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
}

export interface GovernanceModalHandle extends ModalHandle {
  /** The body lines currently visible (tests). */
  visibleLines(): readonly string[];
  /** Every body line, wrapped to the panel width (tests). */
  allLines(): readonly string[];
  /** The header text (tests). */
  header(): string;
  /** Re-read the stored report and repaint (after an outside write). */
  reload(): Promise<void>;
  /** Settles once the initial read has painted. */
  readonly ready: Promise<void>;
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

  let read: GovernanceReportRead | undefined;
  let markdown: string | undefined;
  let scroll = 0;
  let width: number | undefined;
  let headerNode: { content: unknown } | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  // Filled once the modal is open; `onClose` (which can run first) reads it.
  const keys: { off?: () => void } = {};

  const bodyLines = (): string[] => {
    if (read === undefined) return ["Reading the stored report…"];
    if (read.state === "absent") return ["No governance report yet. Press r to run one in the background."];
    if (read.state === "malformed") {
      return [`Stored governance report is unreadable (${read.reason}).`, "Press r to run a new one — it rewrites it."];
    }
    const text = markdown ?? renderGovernanceMarkdown(read.report);
    return wrapLines(text.replace(/\n+$/, ""), width).split("\n");
  };
  const headerText = (): string => {
    const run = options.runner.state();
    const runNote =
      run.kind === "running" ? " · running…" : run.kind === "failed" ? ` · last run failed: ${run.reason}` : "";
    if (read?.state !== "present") return `no stored report${runNote}`;
    const r = read.report;
    return `generated_at ${formatReportDate(r.generatedAt)} · filters ${filtersText(r.filters)} · all_projects ${r.allProjects}${runNote}`;
  };
  const visible = (): string[] => windowLines(bodyLines(), scroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    scroll = clampScroll(scroll, bodyLines().length, bodyRows);
    if (headerNode !== undefined) {
      const text = wrapLines(headerText(), width).split("\n").slice(0, HEADER_TEXT_ROWS).join("\n");
      headerNode.content = core.t`${dimChunk(core, text)}`;
    }
    if (bodyNode !== undefined) bodyNode.content = core.t`${roleChunk(core, "text", visible().join("\n"))}`;
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
    paint();
  };

  const unsubscribeRunner = options.runner.subscribe((_state, event) => {
    if (event === "finished") {
      scroll = 0;
      void reload();
    } else {
      paint();
    }
  });
  // A theme listener runs inside `applyThemeId` for EVERY subscriber; one whose
  // renderables were already torn down (renderer destroyed before close) must
  // not throw into the others.
  const safePaint = (): void => {
    try {
      paint();
    } catch {
      // destroyed renderables: nothing left to recolour
    }
  };
  const unsubscribeTheme = onThemeChange(() => safePaint());

  const handle = openModal(core, chrome as never, {
    title: GOVERNANCE_COMMAND,
    tabs: [{ id: "report", label: "Report" }],
    footer: GOVERNANCE_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      headerNode = new core.TextRenderable(r as never, { id: "gov-header", content: "" }) as never;
      bodyNode = new core.TextRenderable(r as never, { id: "gov-body", content: "", marginTop: 1 }) as never;
      parent.add(headerNode);
      parent.add(bodyNode);
      paint();
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
    unsubscribeTheme();
    return undefined;
  }

  keys.off = options.onKeypress((key) => {
    if (closed) return;
    const token = key.name || key.sequence;
    const total = bodyLines().length;
    if (token === "up" || token === "k") scroll = clampScroll(scroll - 1, total, bodyRows);
    else if (token === "down" || token === "j") scroll = clampScroll(scroll + 1, total, bodyRows);
    else if (token === "pageup") scroll = clampScroll(scroll - bodyRows, total, bodyRows);
    else if (token === "pagedown") scroll = clampScroll(scroll + bodyRows, total, bodyRows);
    else if (token === "home") scroll = 0;
    else if (token === "end") scroll = clampScroll(total, total, bodyRows);
    else if (token === "r") {
      void options.runner.start();
    } else return;
    paint();
  });

  const ready = reload();
  return {
    ...handle,
    visibleLines: visible,
    allLines: bodyLines,
    header: headerText,
    reload,
    ready,
  };
}

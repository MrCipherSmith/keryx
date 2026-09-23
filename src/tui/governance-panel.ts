// Flow 300 T6 (AC1, AC2): the sidebar's Governance section and the runner that
// produces a report in the background.
//
// The runner calls exactly what bare `keryx governance report` calls —
// `buildGovernanceReport` then `writeGovernanceArtifacts`, current project, no
// filters, not all projects — IN this process. The report is read-only over
// recorded artifacts (no lock, no model, no network), so running it here gives
// the CLI's output byte for byte with no second binary to drift from. It never
// goes through the model's JobRegistry: a finished JobRegistry task becomes a
// task-notification that starts an agent turn, and a UI click must never cost
// a model turn.
//
// The section is always present (one label row, one value row), mounted after
// Jobs at the bottom of the scrollable `sidebarTop`, so it can never push
// Model/Context/Tools/Status off a 24-row terminal.

import {
  buildGovernanceReport,
  readLatestGovernanceReport,
  writeGovernanceArtifacts,
  type GovernanceReport,
  type GovernanceReportRead,
} from "../governance/service";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { onThemeChange, type TextRole } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type GovernanceRunState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly startedAt: string }
  | { readonly kind: "done"; readonly generatedAt: string }
  | { readonly kind: "failed"; readonly reason: string; readonly at: string };

/** Emitted once per run, on the transition out of `running`. */
export type GovernanceRunEvent = "finished" | "failed";

export interface GovernanceRunner {
  state(): GovernanceRunState;
  /**
   * Start a run unless one is in flight. Returns the run's completion promise
   * (never rejects), or `undefined` when a run was already going — a second
   * click starts nothing.
   */
  start(): Promise<GovernanceRunState> | undefined;
  subscribe(listener: (state: GovernanceRunState, event: GovernanceRunEvent | undefined) => void): () => void;
}

export interface GovernanceRunnerOptions {
  cwd: string;
  /** Injectable for tests (a deferred builder). Default: the CLI's own `buildGovernanceReport`. */
  build?: typeof buildGovernanceReport;
  /** Default: the CLI's own `writeGovernanceArtifacts`. */
  write?: typeof writeGovernanceArtifacts;
  now?: () => Date;
}

/** The filters bare `keryx governance report` passes (`parseFilters` with no flags). */
export const CLI_DEFAULT_GOVERNANCE_FILTERS = {
  flow: undefined,
  owner: undefined,
  since: undefined,
  until: undefined,
} as const;

export function createGovernanceRunner(options: GovernanceRunnerOptions): GovernanceRunner {
  const build = options.build ?? buildGovernanceReport;
  const write = options.write ?? writeGovernanceArtifacts;
  const now = options.now ?? (() => new Date());
  let current: GovernanceRunState = { kind: "idle" };
  const listeners = new Set<(state: GovernanceRunState, event: GovernanceRunEvent | undefined) => void>();
  const emit = (event: GovernanceRunEvent | undefined): void => {
    for (const listener of [...listeners]) {
      try {
        listener(current, event);
      } catch {
        // a subscriber's failure never strands the runner in `running`
      }
    }
  };
  return {
    state: () => current,
    start() {
      if (current.kind === "running") return undefined;
      current = { kind: "running", startedAt: now().toISOString() };
      emit(undefined);
      return (async (): Promise<GovernanceRunState> => {
        try {
          const report: GovernanceReport = await build({
            cwd: options.cwd,
            filters: { ...CLI_DEFAULT_GOVERNANCE_FILTERS },
            allProjects: false,
            now,
          });
          await write(options.cwd, report);
          current = { kind: "done", generatedAt: report.generatedAt };
          emit("finished");
        } catch (error) {
          current = { kind: "failed", reason: error instanceof Error ? error.message : String(error), at: now().toISOString() };
          emit("failed");
        }
        return current;
      })();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export const GOVERNANCE_NO_REPORT = "no report — click to run";
export const GOVERNANCE_RUNNING = "running…";
export const GOVERNANCE_FAILED = "failed — click to retry";

/** What a click on the row does. */
export type GovernanceRowAction = "run" | "open" | "none";

export interface GovernanceRow {
  readonly text: string;
  readonly role: TextRole;
  readonly action: GovernanceRowAction;
}

/** `2026-09-23T05:40:12.000Z` → `2026-09-23 05:40` (UTC, as recorded). */
export function formatReportDate(iso: string): string {
  return iso.trim().replace("T", " ").slice(0, 16);
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * One of exactly four states.
 *
 * - A run in flight wins.
 * - A failed run shows `failed — click to retry`, unless the stored report is
 *   NEWER than the failure (another process wrote one since): then that report
 *   is what there is to show (review F7).
 * - Otherwise the stored report decides — absent and malformed both read as
 *   "no report", and a report deleted since the last run reads as "no report"
 *   too. The run's own `generatedAt` is used only in the gap between a run
 *   finishing and the re-read of what it wrote (`readIsStale`).
 */
export function projectGovernanceRow(
  read: GovernanceReportRead | undefined,
  run: GovernanceRunState,
  width: number,
  options: { readIsStale?: boolean } = {},
): GovernanceRow {
  if (run.kind === "running") return { text: fit(GOVERNANCE_RUNNING, width), role: "accent", action: "none" };
  const stored = read?.state === "present" ? read.report.generatedAt : undefined;
  if (run.kind === "failed" && !(stored !== undefined && stored > run.at)) {
    return { text: fit(GOVERNANCE_FAILED, width), role: "error", action: "run" };
  }
  const ran = run.kind === "done" && options.readIsStale === true ? run.generatedAt : undefined;
  const newest = stored === undefined ? ran : ran === undefined || stored >= ran ? stored : ran;
  if (newest === undefined) {
    // A malformed stored report is never rebuilt behind the operator's back
    // (review F15): the click opens the modal, which gives the reason and
    // offers `r` to rebuild it.
    return { text: fit(GOVERNANCE_NO_REPORT, width), role: "attention", action: read?.state === "malformed" ? "open" : "run" };
  }
  return { text: fit(`last report ${formatReportDate(newest)}`, width), role: "muted", action: "open" };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

type PanelParent = { add(child: unknown): void };
type TextNode = { content: unknown; onMouseDown?: (() => void) | undefined };

export interface GovernancePanelOptions {
  cwd: string;
  runner: GovernanceRunner;
  width: number;
  /** Opens the report modal (the `last report` state's click). */
  onOpen: () => void;
  /** Injectable for tests. Default `readLatestGovernanceReport`. */
  readLatest?: (cwd: string) => Promise<GovernanceReportRead>;
}

export interface GovernancePanelHandle {
  /** Re-read the stored report and repaint. */
  refresh(): Promise<void>;
  /** What the value row says right now (tests, and the `/governance` router). */
  row(): GovernanceRow;
  /** The last stored-report read. */
  lastRead(): GovernanceReportRead | undefined;
  /** What a click does now: run, open, or nothing. Returns the action taken. */
  activate(): GovernanceRowAction;
  dispose(): void;
}

export function mountGovernancePanel(
  otui: unknown,
  renderer: unknown,
  parent: unknown,
  options: GovernancePanelOptions,
): GovernancePanelHandle {
  const core = otui as OpenTui;
  const box = new core.BoxRenderable(renderer as never, {
    id: "sb-governance",
    flexDirection: "column",
    flexShrink: 0,
  });
  (parent as PanelParent).add(box);
  const readLatest = options.readLatest ?? readLatestGovernanceReport;
  let read: GovernanceReportRead | undefined;
  let generation = 0;
  let disposed = false;

  const label = new core.TextRenderable(renderer as never, {
    id: "sb-governance-k",
    content: core.t`${dimChunk(core, "Governance")}`,
    marginTop: 1,
  });
  const value = new core.TextRenderable(renderer as never, { id: "sb-governance-v", content: "" }) as unknown as TextNode;
  box.add(label);
  box.add(value as never);

  // True from a run finishing until the re-read of what it wrote lands.
  let readIsStale = false;
  const currentRow = (): GovernanceRow => projectGovernanceRow(read, options.runner.state(), options.width, { readIsStale });
  const paint = (): void => {
    if (disposed) return;
    const row = currentRow();
    label.content = core.t`${dimChunk(core, "Governance")}`;
    value.content = core.t`${roleChunk(core, row.role, row.text)}`;
  };
  const activate = (): GovernanceRowAction => {
    const action = currentRow().action;
    if (action === "run") void options.runner.start();
    else if (action === "open") options.onOpen();
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
    const next = await readLatest(options.cwd).catch((error: unknown): GovernanceReportRead => ({
      state: "malformed",
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (disposed || mine !== generation) return;
    read = next;
    readIsStale = false;
    paint();
  };

  const unsubscribeRunner = options.runner.subscribe((_state, event) => {
    // A finished run re-reads the artifact it just wrote; anything else is a
    // state change the row reflects immediately.
    if (event === "finished") {
      readIsStale = true;
      paint();
      void refresh();
    } else paint();
  });
  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("governance-panel", paint, () => disposed || isRenderableGone(box)));
  paint();
  void refresh();

  return {
    refresh,
    row: currentRow,
    lastRead: () => read,
    activate,
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribeRunner();
      unsubscribeTheme();
    },
  };
}

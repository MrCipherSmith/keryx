// Flow 300 T6/T7: one composition of the Governance and Triggers surfaces —
// the two sidebar sections, their two modals, the background governance
// runner, run-now, the shared ledger watcher, and the `/governance` /
// `/triggers` commands. `tui-shell.ts` mounts it once, right after the Jobs
// section, and routes both slash commands (idle AND busy) through
// `handleCommand`. The headless tests mount the very same function on a real
// shell chrome, so what they prove is the shipped wiring, not a replica.
//
// Section order in `sidebarTop` is fixed: sb-jobs → sb-governance →
// sb-triggers → (flow 295) sb-schedules. Flow 295 mounts its section after
// calling this, and can subscribe to `ops.watcher` instead of starting a
// second poller.

import { findAgentCommand } from "../commands/agent-commands";
import { classifyBusyDispatch } from "./busy-dispatch";
import { readLatestGovernanceReport, type GovernanceReportRead } from "../governance/service";
import { createGovernanceRunner, mountGovernancePanel, type GovernancePanelHandle, type GovernanceRunner, type GovernanceRunnerOptions } from "./governance-panel";
import { GOVERNANCE_COMMAND, openGovernanceReport, type GovernanceModalHandle } from "./governance-inspector";
import type { ModalChrome } from "./modal-host";
import { mountTriggersPanel, type TriggersPanelHandle } from "./triggers-panel";
import { openTriggers, TRIGGERS_COMMAND, type LastRunNow, type TriggersModalHandle } from "./triggers-inspector";
import { createTriggerLedgerWatcher, type LedgerInterval, type TriggerLedgerView, type TriggerLedgerWatcher } from "./trigger-ledger";
import { createTriggerRunNow, type InFlightRun, type TriggerRunNow } from "./trigger-run-now";

export { GOVERNANCE_COMMAND, TRIGGERS_COMMAND };

export interface OpsSidebarOptions {
  otui: unknown;
  chrome: ModalChrome & { showToast(message: string): void };
  /** Where the sections go (`chrome.sidebarTop`). */
  parent: unknown;
  /** Project root — the directory `keryx governance report` / `keryx trigger run` would be run in. */
  cwd: string;
  width: number;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  /** Transcript notices for `/governance` (the shell's `io.onSystem`). */
  notice?: (text: string) => void;
  intervalMs?: number;
  interval?: LedgerInterval;
  governance?: Pick<GovernanceRunnerOptions, "build" | "write" | "now">;
  runNow?: TriggerRunNow;
  loadTriggers?: (cwd: string) => Promise<TriggerLedgerView>;
  /** Injectable for tests (the Governance section's stored-report read). */
  readLatestGovernance?: (cwd: string) => Promise<GovernanceReportRead>;
  now?: () => Date;
  /**
   * True while a composer choice or permission prompt owns the keyboard. Both
   * modals ignore keys then (review F11). Default: `chrome.keyboardOwnedElsewhere()`
   * — the dock, a `withOverlay` picker or queue navigation (review N5).
   */
  inputBlocked?: () => boolean;
}

/** How often, at most, the Triggers section re-projects so row ages move on (review F12). */
export const AGE_REPAINT_MS = 60_000;

export interface OpsSidebar {
  readonly governancePanel: GovernancePanelHandle;
  readonly triggersPanel: TriggersPanelHandle;
  readonly runner: GovernanceRunner;
  readonly runNow: TriggerRunNow;
  readonly watcher: TriggerLedgerWatcher;
  /** `/governance`: open the report, or start one when there is none. */
  showGovernance(): Promise<GovernanceModalHandle | undefined>;
  /** `/triggers [name]`. */
  showTriggers(name?: string): TriggersModalHandle | undefined;
  /** Routes `/governance` and `/triggers`; false for any other line. */
  handleCommand(line: string): boolean;
  /** The modals currently open from here, if any (tests; the watcher repaints them). */
  openModals(): { governance: GovernanceModalHandle | undefined; triggers: TriggersModalHandle | undefined };
  /** After every settled agent turn: pick up what the turn (or anyone) wrote. Resolves once repainted. */
  afterTurn(): Promise<void>;
  /** Settles when the repaint the latest watcher change started has finished. */
  repainted(): Promise<void>;
  /**
   * Stop everything this owns. Never signals a run-now child (review F4):
   * returns the runs still in flight, which keep going in the background.
   * Idempotent — a second call returns the same list.
   */
  dispose(): readonly InFlightRun[];
  /** The run-now children still running right now — live, not a snapshot (review N6). */
  inFlightRuns(): readonly InFlightRun[];
}

export function commandToken(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

export function isOpsCommand(line: string): boolean {
  const token = commandToken(line);
  return token === GOVERNANCE_COMMAND || token === TRIGGERS_COMMAND;
}

/**
 * The shell's routing of `/governance` and `/triggers` — called from BOTH of
 * `runLine`'s branches in `tui-shell.ts` (review F6: tests drive this, not a
 * hand-wired `ops.handleCommand`):
 *   - idle: the line resolves through the agent-mode registry
 *     (`findAgentCommand`) and `isOpsCommand` picks it up;
 *   - busy: `classifyBusyDispatch` — the same classifier the busy branch
 *     switches on — must name it `governance`/`triggers`, i.e. read-only and
 *     never deferred to a side worker.
 * Returns whether the line was handled.
 */
export function routeOpsCommand(line: string, busy: boolean, ops: Pick<OpsSidebar, "handleCommand">): boolean {
  const command = findAgentCommand(line, "agent");
  if (command === undefined || !isOpsCommand(command.name)) return false;
  if (busy) {
    const target = classifyBusyDispatch({
      line,
      commandName: command.name,
      isSessionInfo: false,
      isFlows: false,
      isWorkspace: false,
      isReview: false,
      isMcp: false,
      isMcpConsumer: false,
    });
    if (target !== "governance" && target !== "triggers") return false;
  }
  return ops.handleCommand(line);
}

export function mountOpsSidebar(options: OpsSidebarOptions): OpsSidebar {
  const { otui, chrome, cwd } = options;
  const renderer = chrome.renderer;
  const notice = options.notice ?? (() => {});
  const runner = createGovernanceRunner({ cwd, ...options.governance });
  const runNow = options.runNow ?? createTriggerRunNow({ root: cwd });
  const readLatestGovernance = options.readLatestGovernance ?? readLatestGovernanceReport;
  // Review N5: the dock (choices, permission prompts), a `withOverlay`
  // full-screen picker, and queue navigation all own the keyboard — every
  // overlay EXCEPT the modal host's own.
  const inputBlocked =
    options.inputBlocked ??
    ((): boolean => (chrome as { keyboardOwnedElsewhere?: () => boolean }).keyboardOwnedElsewhere?.() === true);
  const clock = options.now ?? (() => new Date());
  let governanceModal: GovernanceModalHandle | undefined;
  let triggersModal: TriggersModalHandle | undefined;

  const openReport = (): GovernanceModalHandle | undefined => {
    governanceModal = openGovernanceReport(otui, chrome, {
      cwd,
      runner,
      onKeypress: options.onKeypress,
      readLatest: readLatestGovernance,
      inputBlocked,
    });
    return governanceModal;
  };

  const governancePanel = mountGovernancePanel(otui, renderer, options.parent, {
    cwd,
    runner,
    width: options.width,
    onOpen: () => {
      openReport();
    },
    readLatest: readLatestGovernance,
  });

  const showTriggers = (name?: string): TriggersModalHandle | undefined => {
    triggersModal = openTriggers(otui, chrome, {
      cwd,
      runNow,
      onKeypress: options.onKeypress,
      ...(name !== undefined ? { initialName: name } : {}),
      ...(options.loadTriggers !== undefined ? { load: options.loadTriggers } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      inputBlocked,
      onRunFinished: (last: LastRunNow) => {
        chrome.showToast(
          last.record === undefined
            ? `trigger ${last.result.name}: exited ${last.result.exitCode}`
            : `trigger ${last.result.name}: ${last.record.outcome}`,
        );
        void triggersPanel.refresh();
      },
    });
    return triggersModal;
  };

  const triggersPanel = mountTriggersPanel(otui, renderer, options.parent, {
    cwd,
    width: options.width,
    onOpen: (name) => {
      showTriggers(name);
    },
    ...(options.loadTriggers !== undefined ? { load: options.loadTriggers } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  // Exactly one toast per run the TUI started.
  const unsubscribeRunner = runner.subscribe((state, event) => {
    if (event === "finished") chrome.showToast("Governance report ready");
    else if (event === "failed" && state.kind === "failed") chrome.showToast(`Governance report failed: ${state.reason}`);
  });

  const watcher = createTriggerLedgerWatcher({
    root: cwd,
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.interval !== undefined ? { interval: options.interval } : {}),
  });
  let repaint: Promise<void> = Promise.resolve();
  let detached: readonly InFlightRun[] | undefined;
  // Review F12: ages ("ok 3m") move on even when no file changed — re-project
  // at least once a minute, on the watcher's own tick (no second timer).
  let agesPaintedAt = clock().getTime();
  const unsubscribeTick = watcher.onTick(() => {
    const t = clock().getTime();
    if (t - agesPaintedAt >= AGE_REPAINT_MS) {
      agesPaintedAt = t;
      triggersPanel.repaint();
    }
  });
  const unsubscribeWatcher = watcher.subscribe((changed) => {
    const work: Array<Promise<void> | undefined> = [];
    if (changed.has("governance")) work.push(governancePanel.refresh(), governanceModal?.reload());
    if (changed.has("runs") || changed.has("triggers")) work.push(triggersPanel.refresh(), triggersModal?.reload());
    repaint = Promise.all(work).then(() => undefined);
  });

  const showGovernance = async (): Promise<GovernanceModalHandle | undefined> => {
    if (runner.state().kind === "running") {
      notice("Governance report is already running in the background — the sidebar shows it when it finishes.\n");
      return openReport();
    }
    // A read that throws is "malformed", exactly as the sidebar maps it (review F15).
    const read: GovernanceReportRead = await readLatestGovernance(cwd).catch((error: unknown) => ({
      state: "malformed",
      reason: error instanceof Error ? error.message : String(error),
    }));
    // Present, or malformed: open the modal. A malformed report is NOT rebuilt
    // automatically — the modal gives its reason and offers `r`.
    if (read.state !== "absent") return openReport();
    void runner.start();
    notice("No governance report yet — running `keryx governance report` in the background; the sidebar shows it when it finishes.\n");
    return undefined;
  };

  return {
    governancePanel,
    triggersPanel,
    runner,
    runNow,
    watcher,
    showGovernance,
    showTriggers,
    handleCommand(line) {
      const token = commandToken(line);
      if (token === GOVERNANCE_COMMAND) {
        void showGovernance();
        return true;
      }
      if (token === TRIGGERS_COMMAND) {
        const arg = line.trim().split(/\s+/)[1];
        showTriggers(arg);
        return true;
      }
      return false;
    },
    inFlightRuns: () => runNow.inFlightRuns(),
    openModals: () => ({ governance: governanceModal, triggers: triggersModal }),
    async afterTurn() {
      await watcher.check();
      await repaint;
    },
    repainted: () => repaint,
    dispose() {
      if (detached !== undefined) return detached;
      // An open modal holds keypress and theme subscriptions; close it with the
      // sections so nothing paints into a renderer that is going away.
      governanceModal?.close({ restoreFocus: false });
      triggersModal?.close({ restoreFocus: false });
      unsubscribeRunner();
      unsubscribeTick();
      unsubscribeWatcher();
      watcher.stop();
      detached = runNow.dispose();
      governancePanel.dispose();
      triggersPanel.dispose();
      return detached;
    },
  };
}

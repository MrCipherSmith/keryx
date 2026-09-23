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

import { readLatestGovernanceReport, type GovernanceReportRead } from "../governance/service";
import { createGovernanceRunner, mountGovernancePanel, type GovernancePanelHandle, type GovernanceRunner, type GovernanceRunnerOptions } from "./governance-panel";
import { GOVERNANCE_COMMAND, openGovernanceReport, type GovernanceModalHandle } from "./governance-inspector";
import type { ModalChrome } from "./modal-host";
import { mountTriggersPanel, type TriggersPanelHandle } from "./triggers-panel";
import { openTriggers, TRIGGERS_COMMAND, type LastRunNow, type TriggersModalHandle } from "./triggers-inspector";
import { createTriggerLedgerWatcher, type LedgerInterval, type TriggerLedgerView, type TriggerLedgerWatcher } from "./trigger-ledger";
import { createTriggerRunNow, type TriggerRunNow } from "./trigger-run-now";

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
}

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
  dispose(): void;
}

export function commandToken(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

export function isOpsCommand(line: string): boolean {
  const token = commandToken(line);
  return token === GOVERNANCE_COMMAND || token === TRIGGERS_COMMAND;
}

export function mountOpsSidebar(options: OpsSidebarOptions): OpsSidebar {
  const { otui, chrome, cwd } = options;
  const renderer = chrome.renderer;
  const notice = options.notice ?? (() => {});
  const runner = createGovernanceRunner({ cwd, ...options.governance });
  const runNow = options.runNow ?? createTriggerRunNow({ root: cwd });
  let governanceModal: GovernanceModalHandle | undefined;
  let triggersModal: TriggersModalHandle | undefined;

  const openReport = (): GovernanceModalHandle | undefined => {
    governanceModal = openGovernanceReport(otui, chrome, {
      cwd,
      runner,
      onKeypress: options.onKeypress,
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
    ...(options.readLatestGovernance !== undefined ? { readLatest: options.readLatestGovernance } : {}),
  });

  const showTriggers = (name?: string): TriggersModalHandle | undefined => {
    triggersModal = openTriggers(otui, chrome, {
      cwd,
      runNow,
      onKeypress: options.onKeypress,
      ...(name !== undefined ? { initialName: name } : {}),
      ...(options.loadTriggers !== undefined ? { load: options.loadTriggers } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
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
    const read = await readLatestGovernanceReport(cwd).catch(() => ({ state: "absent" }) as const);
    if (read.state === "present") return openReport();
    void runner.start();
    if (read.state === "malformed") {
      notice(`Stored governance report is unreadable (${read.reason}) — running a new one in the background.\n`);
      return openReport();
    }
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
    openModals: () => ({ governance: governanceModal, triggers: triggersModal }),
    async afterTurn() {
      await watcher.check();
      await repaint;
    },
    repainted: () => repaint,
    dispose() {
      // An open modal holds keypress and theme subscriptions; close it with the
      // sections so nothing paints into a renderer that is going away.
      governanceModal?.close({ restoreFocus: false });
      triggersModal?.close({ restoreFocus: false });
      unsubscribeRunner();
      unsubscribeWatcher();
      watcher.stop();
      runNow.dispose();
      governancePanel.dispose();
      triggersPanel.dispose();
    },
  };
}

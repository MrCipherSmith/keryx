// Flow 295 T9 (AC10-AC13): the Schedules composition. The shell mounts it right after
// flow 300's `mountOpsSidebar(...)`. It reuses that composition's ledger watcher (one
// poller per shell) and its run-now, instead of starting a second of either.
//
//   - sidebar section `sb-schedules` (`./schedules-panel.ts`);
//   - `/schedules [name]`: the list modal, or one schedule's detail (`./schedules-inspector.ts`);
//   - live refresh: when the watcher sees runs.jsonl, triggers.json or the schedule store
//     change (a timer run in ANOTHER process, a CLI `keryx schedule …`), the section and
//     an open detail modal repaint. An unchanged tick repaints nothing.
//   - report notices: exactly one transcript line per NEW report a scheduled run
//     wrote while the shell is open. Reports that already existed when it started are
//     the baseline and are not announced.

import { findAgentCommand } from "../commands/agent-commands";
import type { ScheduleHost } from "../trigger/install";
import { cardSafe } from "../trigger/schedules";
import { classifyBusyDispatch } from "./busy-dispatch";
import type { OpsSidebar } from "./ops-sidebar";
import type { ModalChrome } from "./modal-host";
import { commandToken } from "./ops-sidebar";
import { mountSchedulesPanel, type SchedulesPanelHandle, type SchedulesPanelOptions } from "./schedules-panel";
import {
  openScheduleDetail,
  openSchedulesList,
  SCHEDULES_COMMAND,
  type ScheduleActions,
  type ScheduleDetailHandle,
  type SchedulesListHandle,
  type SchedulesModalOptions,
} from "./schedules-inspector";
import { scheduledEntries, type TriggerLedgerView } from "./trigger-ledger";

export { SCHEDULES_COMMAND };

export interface SchedulesSidebarOptions {
  otui: unknown;
  chrome: ModalChrome & { showToast(message: string): void };
  parent: unknown;
  cwd: string;
  width: number;
  /** The composition this one builds on: its watcher and its run-now. */
  ops: Pick<OpsSidebar, "watcher" | "runNow">;
  onKeypress: SchedulesModalOptions["onKeypress"];
  /** One transcript line (the shell's `io.onSystem`). */
  notice?: (text: string) => void;
  actions?: ScheduleActions;
  load?: (cwd: string) => Promise<TriggerLedgerView>;
  describeInstall?: SchedulesModalOptions["describeInstall"];
  /** The row's "not installed" check (L4). */
  isInstalled?: SchedulesPanelOptions["isInstalled"];
  /** The scheduler host the default Overview facts read. */
  host?: ScheduleHost;
  /** M3a: the process environment (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  inputBlocked?: () => boolean;
}

export interface SchedulesSidebar {
  readonly panel: SchedulesPanelHandle;
  /** `/schedules [name]`. */
  show(name?: string): SchedulesListHandle | ScheduleDetailHandle | undefined;
  /** Routes `/schedules`; false for any other line. */
  handleCommand(line: string): boolean;
  openModals(): { list: SchedulesListHandle | undefined; detail: ScheduleDetailHandle | undefined };
  /** Settles when the repaint the latest watcher change started has finished. */
  repainted(): Promise<void>;
  dispose(): void;
}

export function isSchedulesCommand(line: string): boolean {
  return commandToken(line) === SCHEDULES_COMMAND;
}

/**
 * The shell's routing of `/schedules`, called from BOTH of `runLine`'s branches in
 * `tui-shell.ts` (as `routeOpsCommand` is for `/governance` and `/triggers`):
 *   - idle: the line resolves through the agent-mode registry (`findAgentCommand`);
 *   - busy: `classifyBusyDispatch` must name it `schedules` (read-only, never deferred).
 * Returns whether the line was handled.
 */
export function routeSchedulesCommand(line: string, busy: boolean, schedules: Pick<SchedulesSidebar, "handleCommand">): boolean {
  const command = findAgentCommand(line, "agent");
  if (command === undefined || command.name !== SCHEDULES_COMMAND) return false;
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
    if (target !== "schedules") return false;
  }
  return schedules.handleCommand(line);
}

export function mountSchedulesSidebar(options: SchedulesSidebarOptions): SchedulesSidebar {
  const { otui, chrome, cwd } = options;
  const inputBlocked =
    options.inputBlocked ?? ((): boolean => (chrome as { keyboardOwnedElsewhere?: () => boolean }).keyboardOwnedElsewhere?.() === true);
  const notice = options.notice ?? (() => {});
  let list: SchedulesListHandle | undefined;
  let detail: ScheduleDetailHandle | undefined;
  // Reports already on record when the shell opened: the baseline, never announced.
  let knownReports: Set<string> | undefined;

  const announceNewReports = (view: TriggerLedgerView): void => {
    const current = new Map<string, { name: string; outcome: string; usd: number | undefined }>();
    for (const item of scheduledEntries(view)) {
      for (const record of item.records) {
        const reportPath = record.agentTask?.reportPath;
        if (reportPath !== undefined) {
          current.set(reportPath, { name: item.entry.name, outcome: record.outcome, usd: record.cost.recorded ? record.cost.usd : undefined });
        }
      }
    }
    if (knownReports === undefined) {
      knownReports = new Set(current.keys());
      return;
    }
    for (const [reportPath, info] of current) {
      if (knownReports.has(reportPath)) continue;
      knownReports.add(reportPath);
      // M2: the ledger is trackable; nothing from it reaches the transcript with control characters.
      notice(
        `${cardSafe(
          `Schedule ${info.name}: new report (${info.outcome}${info.usd !== undefined ? `, $${Number(info.usd.toFixed(4))}` : ""}) — ${SCHEDULES_COMMAND} ${info.name} to read it · ${reportPath}`,
        )}\n`,
      );
    }
  };

  const modalOptions = (): SchedulesModalOptions => ({
    cwd,
    runNow: options.ops.runNow,
    onKeypress: options.onKeypress,
    inputBlocked,
    ...(options.actions !== undefined ? { actions: options.actions } : {}),
    ...(options.load !== undefined ? { load: options.load } : {}),
    ...(options.describeInstall !== undefined ? { describeInstall: options.describeInstall } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    onChanged: () => {
      void panel.refresh();
    },
    onRunFinished: (name, exitCode) => chrome.showToast(`schedule ${name}: run-now exited ${exitCode}`),
  });

  const showDetail = (name: string): ScheduleDetailHandle | undefined => {
    list = undefined;
    detail = openScheduleDetail(otui, chrome, name, modalOptions());
    return detail;
  };
  const showList = (): SchedulesListHandle | undefined => {
    detail = undefined;
    list = openSchedulesList(otui, chrome, { ...modalOptions(), onOpenDetail: (name) => showDetail(name) });
    return list;
  };
  const show = (name?: string): SchedulesListHandle | ScheduleDetailHandle | undefined => (name === undefined ? showList() : showDetail(name));

  const panel = mountSchedulesPanel(otui, chrome.renderer, options.parent, {
    cwd,
    width: options.width,
    onOpen: (name) => {
      show(name);
    },
    onRead: announceNewReports,
    ...(options.isInstalled !== undefined ? { isInstalled: options.isInstalled } : {}),
    ...(options.load !== undefined ? { load: options.load } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  void panel.refresh();

  let repaint: Promise<void> = Promise.resolve();
  const unsubscribeWatcher = options.ops.watcher.subscribe((changed) => {
    if (!(changed.has("runs") || changed.has("triggers") || changed.has("schedules"))) return;
    repaint = Promise.all([panel.refresh(), detail?.reload(), list?.reload()]).then(() => undefined);
  });
  // Next-run times move on without any file changing; re-project on the shared tick.
  const unsubscribeTick = options.ops.watcher.onTick(() => panel.repaint());

  return {
    panel,
    show,
    handleCommand(line) {
      if (!isSchedulesCommand(line)) return false;
      show(line.trim().split(/\s+/)[1]);
      return true;
    },
    openModals: () => ({ list, detail }),
    repainted: () => repaint,
    dispose() {
      list?.close({ restoreFocus: false });
      detail?.close({ restoreFocus: false });
      unsubscribeWatcher();
      unsubscribeTick();
      panel.dispose();
    },
  };
}

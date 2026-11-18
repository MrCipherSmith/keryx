// `/delegate` in the built-in terminal (D-14): the app opens a terminal tab whose process is the vendor
// CLI, and keeps the run as a subagent (runtime "external") in the session's Activity list. keryx sees
// only the start (it handed the argv over); the end is this module's: the tab's process exit code, or
// the user closing the tab. No React; the hook supplies the platform.

import type { PtyTab } from "../platform/panels";
import type { Action } from "./reducer";

/** What keryx answers `/delegate` with (`_meta.keryx.terminal`); the argv's last element is the task. */
export interface DelegateLaunch {
  runId: string;
  agentId: string;
  title: string;
  argv: string[];
  cwd: string;
}

export interface DelegateDeps {
  /** Start `launch.argv` as a terminal tab. Rejects when the program cannot start. */
  openRun(launch: DelegateLaunch): Promise<PtyTab>;
  /** Open the side panel on Terminal and focus `tab`. */
  showTab(tab: PtyTab): void;
  dispatch(a: Action): void;
}

interface Run {
  sessionId: string;
  launch: DelegateLaunch;
  tab: PtyTab | null;
  status: "running" | "done" | "failed";
  /** The tab is still in the panel. */
  open: boolean;
}

export interface DelegateTerminals {
  /** Open the run's tab and register it as a running subagent of `sessionId`. */
  start(sessionId: string, launch: DelegateLaunch): Promise<void>;
  /** A tab's process ended. Ignored for tabs that are not delegate runs. */
  exited(tabId: number, code: number | null): void;
  /** The user closed a tab. A run still running ends as failed "closed". */
  closed(tabId: number): void;
  /** Show the run's tab; false when the run is unknown or its tab is closed. */
  focus(runId: string): boolean;
}

export const taskOf = (launch: DelegateLaunch): string => launch.argv[launch.argv.length - 1] ?? "";

export function createDelegateTerminals(deps: DelegateDeps): DelegateTerminals {
  const runs = new Map<string, Run>();
  const byTab = new Map<number, string>();
  // A process can end before `openRun` has answered with its tab id.
  const early = new Map<number, number | null>();

  const upsert = (run: Run, status: Run["status"], detail: string): void => {
    run.status = status;
    deps.dispatch({
      t: "subagent",
      sessionId: run.sessionId,
      event: {
        kind: "upsert",
        id: run.launch.runId,
        label: run.launch.title,
        status,
        detail,
        task: taskOf(run.launch),
        runtime: "external",
        agentId: run.launch.agentId,
      },
    });
  };

  const end = (run: Run, code: number | null): void => {
    if (run.status !== "running") return;
    if (code === 0) upsert(run, "done", "exit 0");
    else upsert(run, "failed", code === null ? "ended by a signal" : `exit ${code}`);
  };

  return {
    async start(sessionId, launch) {
      const run: Run = { sessionId, launch, tab: null, status: "running", open: true };
      runs.set(launch.runId, run);
      upsert(run, "running", "in the terminal");
      let tab: PtyTab;
      try {
        tab = await deps.openRun(launch);
      } catch (e) {
        run.open = false;
        upsert(run, "failed", `could not start: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      run.tab = tab;
      byTab.set(tab.id, launch.runId);
      deps.showTab(tab);
      if (early.has(tab.id)) {
        end(run, early.get(tab.id) ?? null);
        early.delete(tab.id);
      }
    },
    exited(tabId, code) {
      const id = byTab.get(tabId);
      const run = id === undefined ? undefined : runs.get(id);
      if (!run) {
        early.set(tabId, code);
        return;
      }
      end(run, code);
    },
    closed(tabId) {
      const id = byTab.get(tabId);
      const run = id === undefined ? undefined : runs.get(id);
      if (!run) return;
      run.open = false;
      if (run.status === "running") upsert(run, "failed", "closed");
    },
    focus(runId) {
      const run = runs.get(runId);
      if (!run || !run.open || !run.tab) return false;
      deps.showTab(run.tab);
      return true;
    },
  };
}

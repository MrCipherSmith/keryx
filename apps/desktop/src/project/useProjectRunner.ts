// Runs a project command as its own terminal tab: the process is the window's keryx with `args`, in the
// project folder, so its output streams in the side panel and the tab shows its exit code.

import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../components/Toasts";
import { isTauri } from "../platform/backend";
import { onPtyExit, ptyOpenRun } from "../platform/panels";
import { showTerminalTab } from "../panels/panelBus";
import { commandLine } from "./projectCommands";

export type RunProjectCommand = (args: readonly string[], title: string) => Promise<boolean>;

export function useProjectRunner(cwd: string, keryxPath: string | null): RunProjectCommand {
  const toast = useToast();
  // Tabs this window started for project commands: their exit is reported as a toast.
  const tabs = useRef(new Map<number, string>());
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    let off: (() => void) | null = null;
    void onPtyExit(({ id, code }) => {
      const title = tabs.current.get(id);
      if (title === undefined) return;
      tabs.current.delete(id);
      if (code === 0) toast({ level: "ok", title: `${title} finished` });
      else toast({ level: "error", title: `${title} failed`, body: code === null ? "Ended by a signal." : `Exit code ${code}. The terminal tab has its output.` });
    }).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, [toast]);

  return useCallback(
    async (args, title) => {
      const line = commandLine(args);
      if (!isTauri()) {
        toast({ level: "error", title: "Needs the Keryx app", body: "Project commands run in the app's terminal; browser dev mode has none.", detail: line });
        return false;
      }
      if (!keryxPath) {
        toast({ level: "error", title: "keryx has not started", body: "Wait until the window is connected, then run it again." });
        return false;
      }
      try {
        const tab = await ptyOpenRun(cwd, [keryxPath, ...args], title, 100, 30);
        tabs.current.set(tab.id, title);
        showTerminalTab(tab);
        return true;
      } catch (e) {
        toast({ level: "error", title: `Could not start ${title}`, body: e instanceof Error ? e.message : String(e), detail: line });
        return false;
      }
    },
    [cwd, keryxPath, toast],
  );
}

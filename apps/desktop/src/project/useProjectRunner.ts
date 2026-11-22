// Runs a project command as its own terminal tab: the process is the window's keryx with `args`, in the
// project folder, so its output streams in the side panel and the tab shows its exit code.

import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../components/Toasts";
import { isTauri } from "../platform/backend";
import { onPtyExit, ptyList, ptyOpenRun } from "../platform/panels";
import { showTerminalTab } from "../panels/panelBus";
import { commandLine } from "./projectCommands";

type ExitCallback = (code: number | null) => void;
export type RunProjectCommand = (args: readonly string[], title: string, onExit?: ExitCallback) => Promise<boolean>;

export function useProjectRunner(cwd: string, keryxPath: string | null): RunProjectCommand {
  const toast = useToast();
  // Tabs this window started for project commands: their exit is reported as a toast.
  const tabs = useRef(new Map<number, { title: string; onExit?: ExitCallback }>());
  const complete = useCallback((id: number, code: number | null) => {
    const task = tabs.current.get(id);
    if (!task) return;
    tabs.current.delete(id);
    if (code === 0) toast({ level: "ok", title: `${task.title} finished` });
    else toast({ level: "error", title: `${task.title} failed`, body: code === null ? "Ended by a signal." : `Exit code ${code}. The terminal tab has its output.` });
    task.onExit?.(code);
  }, [toast]);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    let off: (() => void) | null = null;
    void onPtyExit(({ id, code }) => complete(id, code)).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, [complete]);

  return useCallback(
    async (args, title, onExit) => {
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
        tabs.current.set(tab.id, onExit ? { title, onExit } : { title });
        showTerminalTab(tab);
        if (!tab.running) complete(tab.id, tab.exitCode);
        else if (onExit) {
          // A short command can exit before its initial IPC reply arrives.
          void ptyList().then(current => {
            const latest = current.find(item => item.id === tab.id);
            if (latest && !latest.running) complete(tab.id, latest.exitCode);
          }).catch(() => {});
        }
        return true;
      } catch (e) {
        toast({ level: "error", title: `Could not start ${title}`, body: e instanceof Error ? e.message : String(e), detail: line });
        return false;
      }
    },
    [cwd, keryxPath, toast, complete],
  );
}

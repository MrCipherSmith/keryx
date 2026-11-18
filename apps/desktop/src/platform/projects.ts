// Projects kept live in the background (src-tauri/src/projects.rs). Each project runs in its own
// window; switching hides the one you leave instead of stopping its keryx. Browser dev mode has
// one page and no windows: there these calls do nothing and switching reloads the page instead.

import { invoke, isTauri, listen, type Unlisten } from "./backend";
import type { ProjectActivity } from "../shell/projectRail";

export interface LiveProject {
  cwd: string;
  activity: ProjectActivity;
  /** Its window is on screen (the open project, or one opened in a window of its own). */
  visible: boolean;
}

/** Tell the other windows which project this window shows (null: none, e.g. the welcome screen). */
export function projectRegister(cwd: string | null): Promise<void> {
  return isTauri() ? invoke<void>("project_register", { cwd }) : Promise.resolve();
}

export function reportProjectActivity(activity: ProjectActivity): Promise<void> {
  return isTauri() ? invoke<void>("project_activity", { activity }) : Promise.resolve();
}

/** Switch this window to `cwd`, keeping the current project running in the background. False when the host cannot (browser dev mode). */
export async function projectSwitch(cwd: string): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke<void>("project_switch", { cwd });
  return true;
}

export function projectsState(): Promise<LiveProject[]> {
  return isTauri() ? invoke<LiveProject[]>("projects_state") : Promise.resolve([]);
}

export function onProjectsState(handler: (projects: LiveProject[]) => void): Promise<Unlisten> {
  return isTauri() ? listen<LiveProject[]>("projects://state", handler, "app") : Promise.resolve(() => {});
}

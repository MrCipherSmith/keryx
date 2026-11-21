// Projects kept live in the background (src-tauri/src/projects.rs). Each project runs in its own
// view inside a host window; switching hides the view you leave (its keryx keeps running) and shows
// the target's view in the same window. Browser dev mode has one page and no windows: there these
// calls do nothing and switching reloads the page instead.

import { invoke, isTauri, listen, type Unlisten } from "./backend";
import type { ProjectActivity } from "../shell/projectRail";

export interface LiveProject {
  cwd: string;
  activity: ProjectActivity;
  /** Its view is the one in front of a window (the open project, or one open in another window). */
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
export async function projectSwitch(cwd: string, setupFinding?: string): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke<void>("project_switch", { cwd, setupFinding });
  return true;
}

export function projectsState(): Promise<LiveProject[]> {
  return isTauri() ? invoke<LiveProject[]>("projects_state") : Promise.resolve([]);
}

export function onProjectsState(handler: (projects: LiveProject[]) => void): Promise<Unlisten> {
  return isTauri() ? listen<LiveProject[]>("projects://state", handler, "app") : Promise.resolve(() => {});
}

/** The handoff lives in the native target view until it subscribes. */
export async function onProjectSetupRequest(listener: (finding: string) => void): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  let active = true;
  const read = async () => {
    const finding = await takeProjectSetupRequest();
    if (active && typeof finding === "string") listener(finding);
  };
  const off = await listen("projects://setup-requested", () => void read().catch(() => {}));
  void read().catch(() => {});
  return () => { active = false; off(); };
}


export function takeProjectSetupRequest(): Promise<string | null> {
  return isTauri() ? invoke<string | null>("project_take_setup") : Promise.resolve(null);
}

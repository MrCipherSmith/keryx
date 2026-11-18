// The projects on the left rail: a stable, user-ordered list (not the most-recent order of
// recentProjects, so icons do not jump around on every switch). Per-viewer, in localStorage.

import type { SessionMark } from "../session/reducer";

const KEY = "keryx.railProjects.v1";
export const RAIL_MAX = 12;

function readStored(): string[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && p.length > 0) : null;
  } catch {
    return null;
  }
}

function write(list: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the rail still shows this window's list */
  }
}

/**
 * The rail's projects with `current` on it. The first time, it is seeded from the recent projects;
 * after that, a project opened for the first time is added at the end. At most RAIL_MAX are kept;
 * the oldest ones that are not current fall off.
 */
export function railProjects(current: string, recents: readonly string[], stored: string[] | null = readStored()): string[] {
  let list = stored ?? recents.slice(0, RAIL_MAX - 1).slice().reverse().filter((p) => p !== current);
  if (!list.includes(current)) list = [...list, current];
  while (list.length > RAIL_MAX) {
    const drop = list.findIndex((p) => p !== current);
    list = list.filter((_, i) => i !== drop);
  }
  return list;
}

/** railProjects, saved. */
export function syncRailProjects(current: string, recents: readonly string[]): string[] {
  const list = railProjects(current, recents);
  write(list);
  return list;
}

export function removeRailProject(project: string): string[] {
  const list = (readStored() ?? []).filter((p) => p !== project);
  write(list);
  return list;
}

/** One or two letters for a folder name: "vantage-frontend" → "VF", "keryx" → "KE", "my app 2" → "MA". */
export function projectInitials(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** A stable hue (0–359) for a project path, so each icon keeps its color. */
export function projectHue(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % 360;
}

export type ProjectActivity = "action" | "busy" | "idle";

/** What the rail shows for a project's live sessions: a dialog waiting beats a turn running. */
export function projectActivity(marks: Readonly<Record<string, SessionMark>>): ProjectActivity {
  const all = Object.values(marks);
  if (all.some((m) => m.waiting)) return "action";
  if (all.some((m) => m.busy || m.running > 0)) return "busy";
  return "idle";
}

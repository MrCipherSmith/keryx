// Per-viewer UI preferences in localStorage (theme, send key, sidebar).
// Conveniences only: everything works with storage unavailable.

import { useSyncExternalStore } from "react";

export interface Prefs {
  theme: "system" | "light" | "dark";
  sendKey: "enter" | "mod-enter";
  sessionSidebar: boolean;
}

const KEY = "keryx.prefs.v1";
const DEFAULTS: Prefs = { theme: "system", sendKey: "enter", sessionSidebar: true };

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const subs = new Set<() => void>();

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep in memory */
  }
  applyTheme();
  subs.forEach((s) => s());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}

export function applyTheme(): void {
  const root = document.documentElement;
  if (current.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", current.theme);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

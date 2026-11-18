// Requests to the side panel from elsewhere in the window: the Run buttons (D-13).

import { setPrefs } from "../lib/prefs";
import { ptyClose, type PtyTab } from "../platform/panels";

type RunListener = (command: string) => void;

let listener: RunListener | null = null;
let pending: string[] = [];

/** Type `command` and Enter into the active terminal tab, opening the panel (and a tab) when needed. */
export function runInTerminal(command: string): void {
  setPrefs({ sidePanel: "terminal" });
  if (listener) listener(command);
  else pending.push(command);
}

/** The terminal panel takes run requests; ones made before it mounted are delivered at once. */
export function onRunRequest(l: RunListener): () => void {
  listener = l;
  const queued = pending;
  pending = [];
  queued.forEach((c) => l(c));
  return () => {
    if (listener === l) listener = null;
  };
}

type TabListener = (tab: PtyTab) => void;

let tabListener: TabListener | null = null;
let pendingTabs: PtyTab[] = [];

/** Open the panel on Terminal and show `tab` (adding it when the panel does not list it yet), focused. */
export function showTerminalTab(tab: PtyTab): void {
  setPrefs({ sidePanel: "terminal" });
  if (tabListener) tabListener(tab);
  else pendingTabs.push(tab);
}

/** The terminal panel takes tab requests; ones made before it mounted are delivered at once. */
export function onShowTab(l: TabListener): () => void {
  tabListener = l;
  const queued = pendingTabs;
  pendingTabs = [];
  queued.forEach((t) => l(t));
  return () => {
    if (tabListener === l) tabListener = null;
  };
}

let closeListener: ((id: number) => void) | null = null;
/** Close terminal tab `tab` and kill its process (a model-started `/delegate` run that returned its answer). */
export function closeTerminalTab(tab: PtyTab): void {
  pendingTabs = pendingTabs.filter((t) => t.id !== tab.id);
  if (closeListener) closeListener(tab.id);
  else {
    void ptyClose(tab.id).catch(() => {});
    notifyTabClosed(tab.id);
  }
}
/** The terminal panel closes tabs on request, the way its own close button does. */
export function onCloseTabRequest(l: (id: number) => void): () => void {
  closeListener = l;
  return () => {
    if (closeListener === l) closeListener = null;
  };
}
const closedListeners = new Set<(id: number) => void>();

/** The user closed terminal tab `id` in the panel. */
export function notifyTabClosed(id: number): void {
  closedListeners.forEach((l) => l(id));
}

export function onTabClosed(l: (id: number) => void): () => void {
  closedListeners.add(l);
  return () => void closedListeners.delete(l);
}

const SHELL_LANGS = new Set(["bash", "sh", "zsh", "shell", "console", "shellscript", "fish", "terminal"]);

export function isShellLang(lang: string): boolean {
  return SHELL_LANGS.has(lang.trim().toLowerCase());
}

// Control characters other than tab, bidi overrides and zero-width characters: text that would not
// run as it reads.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;

/**
 * The command a shell block runs, or null when it is not exactly one command: empty, several lines
 * (a line ending in a backslash continues the command), or text with hidden characters. A leading
 * `$ ` prompt is dropped.
 */
export function runnableCommand(text: string): string | null {
  let t = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").trim();
  if (t.startsWith("$ ")) t = t.slice(2).trimStart();
  if (t === "" || HIDDEN.test(t)) return null;
  const lines = t.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.endsWith("\\")) return null;
  }
  return t;
}

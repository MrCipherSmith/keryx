// Requests to the side panel from elsewhere in the window: the Run buttons (D-13).

import { setPrefs } from "../lib/prefs";
import { ptyClose, type PtyTab } from "../platform/panels";

/** Where a Run click came from (flow 523): the session whose transcript showed the button. */
export interface RunOrigin {
  sessionId: string;
}

/** What a Run button says it does; in a session's transcript its result also goes back to the agent (flow 523). */
export function runButtonTitle(tracked: boolean): string {
  return tracked ? "Run in a new terminal tab; the result goes back to the agent" : "Run in a new terminal tab";
}

/** A Run for the terminal panel: a tab of its own running `command`; `runId` when the run is tracked. */
export interface RunRequest {
  command: string;
  runId?: string;
}

/**
 * The window's tracker of Runs that came from a session (`session/terminalRuns.ts`): the click, the
 * tab the panel opened for it, or why it could not.
 */
export interface RunTracker {
  /** A Run with an origin; returns the run's id. */
  requested(command: string, origin: RunOrigin): string;
  opened(runId: string, tab: PtyTab): void;
  failed(runId: string, error: string): void;
}

let tracker: RunTracker | null = null;
export function setRunTracker(next: RunTracker | null): void {
  tracker = next;
}

type RunListener = (request: RunRequest) => void;

let listener: RunListener | null = null;
let pending: RunRequest[] = [];

/**
 * Run `command` in a new terminal tab of its own, opening the panel when needed (D-13). With `origin`
 * the run is tracked and its result goes to that session; without (Markdown outside a session) it is
 * just the tab.
 */
export function runInTerminal(command: string, origin?: RunOrigin): void {
  setPrefs({ sidePanel: "terminal" });
  const runId = origin && tracker ? tracker.requested(command, origin) : undefined;
  const request: RunRequest = runId === undefined ? { command } : { command, runId };
  if (listener) listener(request);
  else pending.push(request);
}

/** The terminal panel takes run requests; ones made before it mounted are delivered at once. */
export function onRunRequest(l: RunListener): () => void {
  listener = l;
  const queued = pending;
  pending = [];
  queued.forEach((r) => l(r));
  return () => {
    if (listener === l) listener = null;
  };
}

/** The panel opened the run's tab. */
export function runOpened(request: RunRequest, tab: PtyTab): void {
  if (request.runId !== undefined) tracker?.opened(request.runId, tab);
}

/** The panel could not open the run's tab. */
export function runFailed(request: RunRequest, error: string): void {
  if (request.runId !== undefined) tracker?.failed(request.runId, error);
}

const TITLE_MAX = 32;

/**
 * A run tab's title: the command on one line, shortened to `TITLE_MAX` characters. It is cut between code
 * points, never inside a surrogate pair: the title goes to the host, whose JSON parse refuses a lone one.
 */
export function runTabTitle(command: string): string {
  const line = command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("")}…` : line;
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

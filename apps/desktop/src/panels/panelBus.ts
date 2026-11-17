// Requests to the side panel from elsewhere in the window: the Run buttons (D-13).

import { setPrefs } from "../lib/prefs";

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

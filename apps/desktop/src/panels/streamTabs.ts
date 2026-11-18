// Read-only terminal tabs fed by the app instead of a PTY: the output of something keryx runs
// (a background task) shown in the side panel's terminal, where long output reads best.

import { setPrefs } from "../lib/prefs";

/** Starts feeding `write`; `end` marks the source finished. Returns the stop function. */
export type StreamSource = (write: (text: string) => void, end: (note: string) => void) => () => void;

export interface StreamTab {
  /** Stable per source (e.g. `task:<session>:<id>`): opening it again shows the existing tab. */
  key: string;
  title: string;
  /** A tooltip line, e.g. the full command. */
  detail?: string;
  source: StreamSource;
}

type Listener = (tab: StreamTab) => void;
let listener: Listener | null = null;
let pending: StreamTab[] = [];

/** Open the panel on Terminal and show `tab` (an existing tab with the same key is focused instead). */
export function openStreamTab(tab: StreamTab): void {
  setPrefs({ sidePanel: "terminal" });
  if (listener) listener(tab);
  else pending.push(tab);
}

/** The terminal panel takes stream tabs; ones opened before it mounted are delivered at once. */
export function onStreamTab(l: Listener): () => void {
  listener = l;
  const queued = pending;
  pending = [];
  queued.forEach((t) => l(t));
  return () => {
    if (listener === l) listener = null;
  };
}

/** Text for a terminal: bare newlines become CRLF so lines start at the left edge. */
export function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

import { homedir } from "node:os";
import { colorEnabled, style } from "./ui";

// Pure helpers for the pinned shell status bar (flow 032). Everything here is a
// deterministic `→ string` builder that performs NO terminal IO — the stateful
// wiring (scroll-region setup, signals, redraw) lives in the shell TTY wrapper.

const SEP = "  ·  ";
const ELLIPSIS = "…";
const HINT = "/help";

const ESC = "";
const CSI = `${ESC}[`;

/** Collapse a leading `$HOME` in `path` to `~`. */
export function collapseHome(path: string): string {
  const home = homedir();
  if (home.length > 0 && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Middle-truncate `text` to at most `max` visible chars, keeping head + tail. */
function middleTruncate(text: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  if (max <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, max);
  }
  const keep = max - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}${ELLIPSIS}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

export interface StatusBarParts {
  cwd: string;
  provider: string;
  model: string;
  columns: number;
}

/**
 * Build the one-line status bar `~/path · provider/model · /help`, fit within
 * `columns` by middle-truncating the cwd (the provider/model + hint are kept).
 * Plain (no ANSI) when color is disabled; the VISIBLE width never exceeds
 * `columns`.
 */
export function formatStatusBar(parts: StatusBarParts): string {
  const cwdFull = collapseHome(parts.cwd);
  const pm = `${parts.provider}/${parts.model}`;
  const fixed = SEP.length + pm.length + SEP.length + HINT.length;
  const cwdBudget = Math.max(0, parts.columns - fixed);
  const cwd = middleTruncate(cwdFull, cwdBudget);
  const plain = `${cwd}${SEP}${pm}${SEP}${HINT}`;
  const clipped = plain.length > parts.columns ? plain.slice(0, parts.columns) : plain;
  if (!colorEnabled()) {
    return clipped;
  }
  return `${style.cyan(cwd)}${style.gray(SEP)}${style.dim(pm)}${style.gray(SEP)}${style.dim(HINT)}`;
}

export interface ScrollRegion {
  /** Reserve the bottom row: set the scroll region to rows `1..rows-1`. */
  enter: string;
  /** Save cursor → move to `row` → clear the line → write `text` → restore. */
  drawAt: (row: number, text: string) => string;
  /** Reset the scroll region to full screen and show the cursor. */
  exit: string;
}

/**
 * DECSTBM-based reserved-bottom-row control builders for a `rows`-row terminal.
 * The scroll region covers `1..rows-1`; the last row is the pinned bar. Pure.
 */
export function scrollRegion(rows: number): ScrollRegion {
  const bottom = Math.max(1, rows - 1);
  return {
    enter: `${CSI}1;${bottom}r${CSI}${bottom};1H`,
    drawAt: (row, text) => `${ESC}7${CSI}${row};1H${CSI}2K${text}${ESC}8`,
    exit: `${CSI}r${CSI}?25h`,
  };
}

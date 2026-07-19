// Line-based differential terminal renderer for live-streaming markdown in agent
// mode (flow 051, inspired by the Pi coding agent's retained-mode line renderer).
//
// The problem: repainting a growing block of styled text on every streamed token
// without the fragile "count logical lines, jump the cursor up" math that broke
// the flow-048 status bar. The technique: keep the PHYSICAL row count the block
// occupied last time, and on each repaint move the cursor to the block's first
// row, clear to the end of the screen, and reprint — optionally wrapped in
// synchronized-output escapes (`CSI ?2026h/l`) so a capable terminal shows the
// repaint atomically (no flicker).
//
// Everything here is PURE and deterministic (no IO / clock / randomness). The
// only stateful piece, `LiveMarkdownBlock`, takes its terminal sink, width
// source, and markdown renderer as INJECTED dependencies, so it is unit-testable
// without a real TTY.

/** CSI SGR / cursor / erase escape sequences (for width measurement stripping). */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Remove ANSI escape sequences so a styled string can be measured by width. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// Best-effort "double-width" ranges (CJK, Hangul, kana, fullwidth forms, and the
// common emoji planes). Not a full Unicode width table — enough to keep row
// accounting correct for the scripts and symbols that actually reach the terminal
// while staying small and dependency-free.
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext. A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / symbols & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext. B+
  );
}

/**
 * Visible cell width of a single logical line: ANSI stripped, code points
 * counted, wide code points counted as 2. Best-effort (no grapheme clustering /
 * zero-width-joiner handling) — sufficient for physical-row accounting.
 */
export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Number of PHYSICAL terminal rows a block of logical `lines` occupies at `cols`
 * columns (each line wraps to `ceil(width/cols)` rows; an empty line is 1 row).
 * A non-positive `cols` (unknown width) falls back to one row per logical line.
 */
export function physicalRows(lines: string[], cols: number): number {
  if (cols <= 0) {
    return lines.length;
  }
  let rows = 0;
  for (const line of lines) {
    const width = displayWidth(line);
    rows += width === 0 ? 1 : Math.ceil(width / cols);
  }
  return rows;
}

const CURSOR_UP = (n: number): string => `\x1b[${n}A`;
const CLEAR_TO_END = "\x1b[0J"; // erase from cursor to end of screen
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

export interface Repaint {
  /** The control string that transforms the previous paint into `nextLines`. */
  output: string;
  /** Physical rows the new block occupies (feed back as `prevRows` next time). */
  rows: number;
}

/**
 * Compute the control string to repaint a block in place. The cursor is assumed
 * to sit at the END of the previously-painted block (no trailing newline was
 * emitted). We return to the block's first row (`\r` + cursor-up over
 * `prevRows-1`), clear to the end of the screen, then write the new lines joined
 * by `\n`. On the first paint (`prevRows === 0`) no cursor movement is emitted.
 * With `sync`, the whole sequence is wrapped in synchronized-output markers.
 */
export function computeRepaint(opts: {
  prevRows: number;
  nextLines: string[];
  cols: number;
  sync?: boolean;
}): Repaint {
  const { prevRows, nextLines, cols, sync = false } = opts;
  let body = "";
  if (prevRows > 0) {
    body += "\r";
    if (prevRows > 1) {
      body += CURSOR_UP(prevRows - 1);
    }
    body += CLEAR_TO_END;
  }
  body += nextLines.join("\n");
  const output = sync ? `${SYNC_BEGIN}${body}${SYNC_END}` : body;
  return { output, rows: physicalRows(nextLines, cols) };
}

/** Injected dependencies keeping {@link LiveMarkdownBlock} testable + offline. */
export interface LiveMarkdownBlockDeps {
  /** Terminal sink (real: `process.stdout.write`). */
  out: (text: string) => void;
  /** Current terminal column count (real: `() => process.stdout.columns ?? 80`). */
  cols: () => number;
  /** Markdown → styled text (real: `renderMarkdown`). */
  render: (markdown: string) => string;
  /** Wrap each repaint in synchronized-output escapes. */
  sync: boolean;
}

/**
 * Stateful controller that live-renders a growing markdown block via in-place
 * differential repaints. `append` accumulates streamed text (marking the block
 * dirty); `flush` repaints only when dirty (call it on a coalescing timer to
 * bound repaint frequency); `finalize` does a last repaint, breaks to a fresh
 * line, and resets for the next block.
 *
 * Safety: a terminal-width change since the outstanding block was painted would
 * make the stored physical-row count (and thus the cursor-up) wrong, so we
 * degrade to a FRESH block (emit a newline, forget the previous rows) rather than
 * corrupt the scrollback. No SIGWINCH handler is registered (flow-048 removed
 * that class of readline-conflicting handler); the width is simply re-read each
 * repaint.
 */
export class LiveMarkdownBlock {
  private pending = "";
  private prevRows = 0;
  private prevCols = 0;
  private dirty = false;

  constructor(private readonly deps: LiveMarkdownBlockDeps) {}

  /** Append streamed text; marks the block dirty (does not paint). */
  append(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.pending += text;
    this.dirty = true;
  }

  /** Repaint if dirty. Cheap no-op when nothing changed since the last paint. */
  flush(): void {
    if (!this.dirty) {
      return;
    }
    this.repaint();
    this.dirty = false;
  }

  /** Final repaint, then break to a new line and reset for the next block. */
  finalize(): void {
    if (this.dirty) {
      this.repaint();
      this.dirty = false;
    }
    if (this.prevRows > 0 || this.pending.length > 0) {
      this.deps.out("\n");
    }
    this.pending = "";
    this.prevRows = 0;
    this.prevCols = 0;
  }

  private repaint(): void {
    const cols = this.deps.cols();
    // A width change since the last paint invalidates the stored row count —
    // start a fresh block on a new line instead of a wrong cursor-up.
    if (this.prevRows > 0 && cols !== this.prevCols) {
      this.deps.out("\n");
      this.prevRows = 0;
    }
    const lines = this.deps.render(this.pending).split("\n");
    const { output, rows } = computeRepaint({ prevRows: this.prevRows, nextLines: lines, cols, sync: this.deps.sync });
    this.deps.out(output);
    this.prevRows = rows;
    this.prevCols = cols;
  }
}

// The shell's outer frame: a thin rounded border with a one-column gutter
// outside it, so the full-screen shell does not run edge to edge. Inside a
// multiplexer pane (herdr, tmux, zellij) or a bare terminal the transcript and
// the sidebar otherwise touch the pane's edges and read as clipped.
//
// The frame costs columns and rows, so it is drawn only when the terminal has
// room to spare ({@link shellFrameFits}); on a small terminal the shell keeps
// every cell, as it did before the frame existed. Every caller that sizes
// something from the terminal (the sidebar geometry store, the busy footer,
// the splash) asks this module for the INNER size instead of reading
// `renderer.width` directly, so the two cannot disagree.

/** Blank columns between the terminal edge and the frame, on each side. */
export const SHELL_FRAME_GUTTER_X = 1;
/** Blank rows between the terminal edge and the frame, top and bottom. */
export const SHELL_FRAME_GUTTER_Y = 0;
/** The frame's own border: one cell on each side. */
const SHELL_FRAME_BORDER = 1;

/** Columns the frame takes from the terminal width (both sides together). */
export const SHELL_FRAME_COLUMNS = 2 * (SHELL_FRAME_GUTTER_X + SHELL_FRAME_BORDER);
/** Rows the frame takes from the terminal height (top and bottom together). */
export const SHELL_FRAME_ROWS = 2 * (SHELL_FRAME_GUTTER_Y + SHELL_FRAME_BORDER);

/**
 * The smallest terminal the shell is laid out for: dialogs (`/connect`,
 * `/settings`) and the busy footer are fitted to 80x24.
 */
export const SHELL_MIN_COLUMNS = 80;
export const SHELL_MIN_ROWS = 24;
/**
 * The frame is drawn only when what is left inside it is still at least
 * {@link SHELL_MIN_COLUMNS} x {@link SHELL_MIN_ROWS}, so it never pushes a
 * dialog or the footer below the size they are fitted to. A smaller terminal
 * keeps every cell, as it did before the frame existed.
 */
export const SHELL_FRAME_MIN_COLUMNS = SHELL_MIN_COLUMNS + SHELL_FRAME_COLUMNS;
export const SHELL_FRAME_MIN_ROWS = SHELL_MIN_ROWS + SHELL_FRAME_ROWS;

/** Whether a terminal of this size gets the frame. */
export function shellFrameFits(terminalColumns: number, terminalRows: number): boolean {
  return terminalColumns >= SHELL_FRAME_MIN_COLUMNS && terminalRows >= SHELL_FRAME_MIN_ROWS;
}

/**
 * Width left for the shell's content: the terminal less the frame when the frame
 * is drawn. `terminalRows` defaults to "tall enough", for callers that only know
 * the width (the sidebar store before the first layout).
 */
export function shellInnerColumns(terminalColumns: number, terminalRows = SHELL_FRAME_MIN_ROWS): number {
  if (!shellFrameFits(terminalColumns, terminalRows)) return terminalColumns;
  return Math.max(1, terminalColumns - SHELL_FRAME_COLUMNS);
}

/** Height left for the shell's content: the terminal less the frame when it is drawn. */
export function shellInnerRows(terminalRows: number, terminalColumns = SHELL_FRAME_MIN_COLUMNS): number {
  if (!shellFrameFits(terminalColumns, terminalRows)) return terminalRows;
  return Math.max(1, terminalRows - SHELL_FRAME_ROWS);
}

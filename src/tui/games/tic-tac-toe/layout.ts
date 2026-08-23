// Tic-tac-toe layout: cell sizes and board-width math. A terminal cell is
// roughly twice as tall as it is wide, so one column of horizontal space and
// zero rows of vertical space read as the same visual gap — a symmetric
// `gap: 1` would stretch the board into a tall rectangle.

export const GAME_CELL_GAP = 1;
/** Board border (2) + horizontal padding (2). */
export const GAME_BOARD_CHROME_X = 4;

export const GAME_CELL_SIZES = {
  large: { width: 9, height: 5 },
  small: { width: 5, height: 3 },
} as const;

/** Columns a board of `cellWidth` cells occupies, chrome included. */
export function gameBoardWidth(cellWidth: number): number {
  return cellWidth * 3 + GAME_CELL_GAP * 2 + GAME_BOARD_CHROME_X;
}

/**
 * The largest cell size that fits the modal body. `renderTab` is handed the
 * panel's inner width, and the panel is 95% of the terminal — so a normal
 * window gets the large board and a cramped one still gets a whole grid
 * rather than a clipped one.
 */
export function resolveCellSize(availableWidth: number): { width: number; height: number } {
  const large = GAME_CELL_SIZES.large;
  return gameBoardWidth(large.width) <= availableWidth ? large : GAME_CELL_SIZES.small;
}

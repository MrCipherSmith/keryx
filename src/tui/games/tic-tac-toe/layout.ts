// Tic-tac-toe layout: cell sizes and board-width/height math. A terminal cell
// is roughly twice as tall as it is wide, so one column of horizontal space
// and zero rows of vertical space read as the same visual gap — a symmetric
// `gap: 1` would stretch the board into a tall rectangle.
//
// The board is sized from the modal body HEIGHT as well as its width: the
// agent panel must fit in the body together with the board ("всё перед
// глазами", no modal-level scroll), so the largest cell size whose board
// REGION (legend + board + status line) fits the panel's leftover height
// wins, and the prompt card gets only what remains — bounded, see
// constants.ts.

import { PANEL_FIXED_ROWS, PANEL_MIN_ROWS, PROMPT_MAX_ROWS, PROMPT_MIN_ROWS } from "../constants";

export const GAME_CELL_GAP = 1;
/** Board border (2) + horizontal padding (2). */
export const GAME_BOARD_CHROME_X = 4;

export const GAME_CELL_SIZES = {
  large: { width: 9, height: 5 },
  medium: { width: 7, height: 4 },
  small: { width: 5, height: 3 },
  tiny: { width: 3, height: 2 },
} as const;

/** Columns a board of `cellWidth` cells occupies, chrome included. */
export function gameBoardWidth(cellWidth: number): number {
  return cellWidth * 3 + GAME_CELL_GAP * 2 + GAME_BOARD_CHROME_X;
}

/** Rows the board grid itself occupies: 3 cell rows + the rounded border. */
export function boardRows(cellHeight: number): number {
  return cellHeight * 3 + 2;
}

/**
 * Rows of the whole board region: legend (1) + its bottom margin (1) + the
 * board grid + the status line (1) + its top margin (1).
 */
export function boardRegionRows(cellHeight: number): number {
  return boardRows(cellHeight) + 4;
}

/**
 * The largest cell size that fits both the available width and height.
 * `availableHeight` is the modal body height MINUS the agent panel's
 * minimum — the rows the game may actually occupy.
 */
export function resolveCellSize(
  availableWidth: number,
  availableHeight: number,
): { width: number; height: number } {
  const candidates: readonly { width: number; height: number }[] = [
    GAME_CELL_SIZES.large,
    GAME_CELL_SIZES.medium,
    GAME_CELL_SIZES.small,
    GAME_CELL_SIZES.tiny,
  ];
  for (const size of candidates) {
    if (gameBoardWidth(size.width) <= availableWidth && boardRegionRows(size.height) <= availableHeight) {
      return size;
    }
  }
  return GAME_CELL_SIZES.tiny;
}

export interface GameBudget {
  cellSize: { width: number; height: number };
  /** Rows the chosen board region occupies (legend + board + status). */
  boardUsedRows: number;
  /** Rows the prompt card gets, bounded to PROMPT_MIN_ROWS..PROMPT_MAX_ROWS. */
  promptRows: number;
  /** Rows the modal body leaves for the board region (what render gets). */
  boardBudgetRows: number;
}

/**
 * The joint board/panel vertical budget for one modal body of `bodyRows`
 * rows: the game gets as much height as the panel's minimum leaves, the
 * board takes the largest size that fits, and the prompt card receives the
 * leftover (bounded). The result sums to the body height — everything is on
 * screen at once, and only the prompt card ever scrolls, inside itself.
 */
export function resolveGameBudget(availableWidth: number, bodyRows: number): GameBudget {
  const boardBudgetRows = Math.max(1, bodyRows - PANEL_MIN_ROWS);
  const cellSize = resolveCellSize(availableWidth, boardBudgetRows);
  const boardUsedRows = boardRegionRows(cellSize.height);
  const promptRows = Math.max(
    PROMPT_MIN_ROWS,
    Math.min(PROMPT_MAX_ROWS, bodyRows - PANEL_FIXED_ROWS - boardUsedRows),
  );
  return { cellSize, boardUsedRows, promptRows, boardBudgetRows };
}

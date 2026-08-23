// Tic-tac-toe rules: pure board logic, no rendering, no prompts.
// The user plays X; the model plays O.
import type { GameState } from "../types";

export type Mark = "X" | "O";
export type Cell = Mark | null;

export const WIN_LINES: readonly (readonly number[])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export interface TicTacToeState {
  board: readonly Cell[];
  turn: Mark;
  winner: Mark | null;
  winLine: readonly number[] | null;
  draw: boolean;
  /** Selected cell (0-8), rendered as the focus border. */
  cursor: number;
}

export function emptyBoard(): readonly Cell[] {
  return Array<Cell>(9).fill(null);
}

export function checkWinner(board: readonly Cell[]): { winner: Mark; line: readonly number[] } | null {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (a === undefined || b === undefined || c === undefined) {
      continue;
    }
    const mark = board[a];
    if (mark !== null && mark !== undefined && mark === board[b] && mark === board[c]) {
      return { winner: mark, line };
    }
  }
  return null;
}

export function freeCells(board: readonly Cell[]): number[] {
  return board.flatMap((cell, index) => (cell === null ? [index] : []));
}

export function placeMark(
  board: readonly Cell[],
  index: number,
  mark: Mark,
): TicTacToeState | undefined {
  if (index < 0 || index > 8 || board[index] !== null) {
    return undefined;
  }
  const next = board.slice();
  next[index] = mark;
  const win = checkWinner(next);
  const draw = win === null && next.every((cell) => cell !== null);
  return {
    board: next,
    turn: win === null && !draw ? (mark === "X" ? "O" : "X") : mark,
    winner: win?.winner ?? null,
    winLine: win?.line ?? null,
    draw,
    cursor: index,
  };
}

export function freshGame(): TicTacToeState {
  return { board: emptyBoard(), turn: "X", winner: null, winLine: null, draw: false, cursor: 4 };
}

export function isGameOver(state: TicTacToeState): boolean {
  return state.winner !== null || state.draw;
}

/**
 * A decent local move for `mark`: take the win, else block the opponent's,
 * else centre, else a corner, else the first free cell. Stand-in when the
 * model cannot answer (timeout / unusable reply).
 */
export function bestLocalMove(board: readonly Cell[], mark: Mark): number | undefined {
  const free = freeCells(board);
  if (free.length === 0) {
    return undefined;
  }
  const opponent: Mark = mark === "X" ? "O" : "X";
  for (const candidate of [mark, opponent]) {
    for (const index of free) {
      const next = board.slice();
      next[index] = candidate;
      if (checkWinner(next)?.winner === candidate) {
        return index;
      }
    }
  }
  for (const index of [4, 0, 2, 6, 8]) {
    if (board[index] === null) {
      return index;
    }
  }
  return free[0];
}

/**
 * Parse the model's reply into a cell index, or `undefined` when it does not
 * name a free cell. The model may answer with prose around the index, so we
 * take the first standalone digit 0-8; anything else fails closed.
 */
export function parseModelMove(reply: string, board: readonly Cell[]): number | undefined {
  if (reply.length === 0) {
    return undefined;
  }
  const match = /\b([0-8])\b/.exec(reply);
  if (match === null) {
    return undefined;
  }
  const index = Number(match[1]);
  return board[index] === null ? index : undefined;
}

/** Narrow helper: cast opaque GameState to TicTacToeState. */
export function asTtt(state: GameState): TicTacToeState {
  return state as TicTacToeState;
}

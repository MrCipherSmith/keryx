// Tic-tac-toe keyboard handling: cursor movement (arrows + vim h/j/k/l) and
// placing the human's X on enter/space. The games modal owns `r`/`esc`.

import type { GameKeyEvent } from "../types";
import type { Mark, TicTacToeState } from "./core";
import { isGameOver, placeMark } from "./core";

function wrapCursor(row: number, col: number): number {
  return ((row + 3) % 3) * 3 + ((col + 3) % 3);
}

export function onKey(state: TicTacToeState, key: GameKeyEvent): TicTacToeState | undefined {
  const name = key.name || key.sequence;
  if (isGameOver(state)) {
    return undefined;
  }
  const row = Math.floor(state.cursor / 3);
  const col = state.cursor % 3;
  if (name === "up" || name === "k") {
    return { ...state, cursor: wrapCursor(row - 1, col) };
  }
  if (name === "down" || name === "j") {
    return { ...state, cursor: wrapCursor(row + 1, col) };
  }
  if (name === "left" || name === "h") {
    return { ...state, cursor: wrapCursor(row, col - 1) };
  }
  if (name === "right" || name === "l") {
    return { ...state, cursor: wrapCursor(row, col + 1) };
  }
  if (name === "return" || name === "enter" || name === "space" || name === " ") {
    if (state.turn !== "X") {
      return undefined;
    }
    return placeMark(state.board, state.cursor, "X");
  }
  return undefined;
}

export function markFor(player: "human" | "model"): Mark {
  return player === "human" ? "X" : "O";
}

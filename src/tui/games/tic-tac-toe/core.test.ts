import { expect, test } from "bun:test";
import {
  bestLocalMove, checkWinner, emptyBoard, freshGame, isGameOver, parseModelMove, placeMark,
  type Cell,
} from "./core";

test("checkWinner finds rows, columns and diagonals", () => {
  expect(checkWinner(["X", "X", "X", null, null, null, null, null, null] as Cell[])?.winner).toBe("X");
  expect(checkWinner([null, null, null, "O", "O", "O", null, null, null] as Cell[])?.winner).toBe("O");
  expect(checkWinner(["X", null, null, null, "X", null, null, null, "X"] as Cell[])?.winner).toBe("X");
  expect(checkWinner(emptyBoard())).toBeNull();
});

test("placeMark updates turn and detects win", () => {
  const state = placeMark(freshGame().board, 0, "X") ?? freshGame();
  expect(state.board[0]).toBe("X");
  expect(state.turn).toBe("O");
  const win = placeMark(["X", "O", "X", "O", "X", null, null, null, null] as Cell[], 8, "X");
  expect(win?.winner).toBe("X");
  expect(win?.winLine).toEqual([0, 4, 8]);
  expect(placeMark(["X", null, null, null, null, null, null, null, null] as Cell[], 0, "O")).toBeUndefined();
  expect(placeMark(emptyBoard(), 9, "X")).toBeUndefined();
});

test("parseModelMove takes a free cell index only", () => {
  expect(parseModelMove("4", emptyBoard())).toBe(4);
  expect(parseModelMove("I choose 2", emptyBoard())).toBe(2);
  expect(parseModelMove("no move", emptyBoard())).toBeUndefined();
  const occupied: Cell[] = ["X", null, null, null, null, null, null, null, null];
  expect(parseModelMove("0", occupied)).toBeUndefined();
});

test("bestLocalMove takes the win first, then the block, then the centre", () => {
  expect(bestLocalMove(["O", "O", null, "X", "X", null, null, null, null] as Cell[], "O")).toBe(2);
  expect(bestLocalMove([null, null, null, "X", "X", null, "O", null, null] as Cell[], "O")).toBe(5);
  expect(bestLocalMove(emptyBoard(), "O")).toBe(4);
});

test("isGameOver and freshGame", () => {
  expect(isGameOver(freshGame())).toBe(false);
  const draw = placeMark(["X", "O", "X", "O", "X", "O", "O", "X", null] as Cell[], 8, "O");
  expect(draw?.winner).toBeNull();
  expect(draw?.draw).toBe(true);
  expect(draw !== undefined && isGameOver(draw)).toBe(true);
});

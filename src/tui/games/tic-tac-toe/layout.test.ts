import { expect, test } from "bun:test";
import { GAME_CELL_SIZES, boardRegionRows, gameBoardWidth, resolveCellSize, resolveGameBudget } from "./layout";
import { GAME_MODEL_TIMEOUT_MS, PANEL_FIXED_ROWS, PROMPT_MAX_ROWS, PROMPT_MIN_ROWS } from "../constants";

test("resolveCellSize takes the largest board that fits width and height", () => {
  // Height 30 is plenty — the width is the gate.
  expect(resolveCellSize(80, 30)).toEqual(GAME_CELL_SIZES.large);
  expect(resolveCellSize(gameBoardWidth(GAME_CELL_SIZES.large.width), 30)).toEqual(GAME_CELL_SIZES.large);
  // One column short of the large board: medium fits, large does not.
  expect(resolveCellSize(gameBoardWidth(GAME_CELL_SIZES.large.width) - 1, 30)).toEqual(GAME_CELL_SIZES.medium);
  expect(resolveCellSize(20, 30)).toEqual(GAME_CELL_SIZES.tiny);
  // Narrow width can never pick a wide board.
  expect(resolveCellSize(10, 30)).toEqual(GAME_CELL_SIZES.tiny);
  // Height gate (the arg is the board-REGION budget, i.e. body rows minus
  // the panel minimum): 21 rows fit the large region, 18 the medium,
  // 15 the small, 12 the tiny; anything smaller falls back to tiny.
  expect(resolveCellSize(110, 21)).toEqual(GAME_CELL_SIZES.large);
  expect(resolveCellSize(110, 20)).toEqual(GAME_CELL_SIZES.medium);
  expect(resolveCellSize(110, 15)).toEqual(GAME_CELL_SIZES.small);
  expect(resolveCellSize(110, 12)).toEqual(GAME_CELL_SIZES.tiny);
  expect(resolveCellSize(110, 1)).toEqual(GAME_CELL_SIZES.tiny);
});

test("boardRegionRows counts legend + board + status", () => {
  expect(boardRegionRows(GAME_CELL_SIZES.large.height)).toBe(3 * 5 + 2 + 4);
  expect(boardRegionRows(GAME_CELL_SIZES.tiny.height)).toBe(3 * 2 + 2 + 4);
});

test("resolveGameBudget splits the body so board + panel sum to it exactly", () => {
  const cases: Array<[number, number, number]> = [
    // [bodyRows, expected cell height, expected prompt rows]
    [33, 5, PROMPT_MIN_ROWS], // 40-row terminal: large board, prompt at the floor
    [29, 3, 7],               // 36-row terminal: small board, prompt takes the leftover
    [24, 2, PROMPT_MIN_ROWS], // 30-row terminal: tiny board, prompt at the floor
    [52, 5, PROMPT_MAX_ROWS], // 60-row terminal: large board, prompt capped at the ceiling
  ];
  for (const [bodyRows, cellHeight, promptRows] of cases) {
    const b = resolveGameBudget(110, bodyRows);
    expect(b.cellSize.height).toBe(cellHeight);
    expect(b.promptRows).toBe(promptRows);
    expect(b.boardUsedRows + PANEL_FIXED_ROWS + b.promptRows).toBeLessThanOrEqual(bodyRows);
  }
});

test("GAME_MODEL_TIMEOUT_MS is raised for slow local models", () => {
  // Was 12s in game-modal.ts; flow 174 raised it so local models can answer.
  expect(GAME_MODEL_TIMEOUT_MS).toBe(60_000);
});

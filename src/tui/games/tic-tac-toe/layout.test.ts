import { expect, test } from "bun:test";
import { GAME_CELL_SIZES, gameBoardWidth, resolveCellSize } from "./layout";
import { GAME_MODEL_TIMEOUT_MS } from "../constants";

test("resolveCellSize takes the large board when it fits", () => {
  expect(resolveCellSize(80)).toEqual(GAME_CELL_SIZES.large);
  expect(resolveCellSize(gameBoardWidth(GAME_CELL_SIZES.large.width))).toEqual(GAME_CELL_SIZES.large);
  expect(resolveCellSize(gameBoardWidth(GAME_CELL_SIZES.large.width) - 1)).toEqual(GAME_CELL_SIZES.small);
  expect(resolveCellSize(20)).toEqual(GAME_CELL_SIZES.small);
});

test("GAME_MODEL_TIMEOUT_MS is raised for slow local models", () => {
  // Was 12s in game-modal.ts; flow 174 raised it so local models can answer.
  expect(GAME_MODEL_TIMEOUT_MS).toBe(60_000);
});

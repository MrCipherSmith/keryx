import { expect, test } from "bun:test";
import { gameSystemPrompt, gameUserPrompt } from "./prompts";
import type { Cell } from "./core";

test("prompts describe the board and the rules", () => {
  expect(gameSystemPrompt()).toContain("0 1 2");
  expect(gameSystemPrompt()).toContain("as O");
  const user = gameUserPrompt(["X", null, null, null, null, null, null, null, null] as Cell[]);
  expect(user).toContain("X . .");
});

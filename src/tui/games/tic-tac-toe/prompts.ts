// Tic-tac-toe prompts: what the model sees each turn (system + board).

import type { Cell } from "./core";

export function gameSystemPrompt(): string {
  return [
    "You are playing tic-tac-toe as O against a human playing X.",
    "The board is 9 cells indexed 0..8, row-major:",
    "0 1 2",
    "3 4 5",
    "6 7 8",
    "Reply with ONLY the index of the cell you choose, as a single digit 0-8.",
    "Choose an empty cell. Prefer winning, then blocking, then center/corner.",
    "Answer immediately. No explanation, no working out — one character.",
  ].join("\n");
}

export function gameUserPrompt(board: readonly Cell[]): string {
  const rows = [0, 1, 2].map((r) => [0, 1, 2].map((c) => board[r * 3 + c] ?? ".").join(" "));
  return `Board (X=you, O=me, .=empty):\n${rows.join("\n")}\n\nMake your move. Reply with one digit 0-8.`;
}

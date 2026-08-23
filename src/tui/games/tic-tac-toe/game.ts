// Tic-tac-toe as one GameDefinition. Rules live in core.ts, prompts in
// prompts.ts, layout in layout.ts, rendering in render.ts, keys in input.ts;
// this file only wires them into the contract.

import type { GameDefinition } from "../types";
import type { Player } from "../types";
import type { TicTacToeState } from "./core";
import { asTtt, bestLocalMove, freshGame, isGameOver, parseModelMove, placeMark } from "./core";
import { gameSystemPrompt, gameUserPrompt } from "./prompts";
import { onKey, markFor } from "./input";
import { render } from "./render";

function statusOf(s: TicTacToeState): string {
  if (s.winner !== null) {
    return `${s.winner} wins!  (r — new game)`;
  }
  if (s.draw) {
    return "Draw!  (r — new game)";
  }
  return s.turn === "X" ? "Your turn — X" : "Agent's turn — O";
}

export const ticTacToeGame: GameDefinition = {
  id: "tic-tac-toe",
  label: "Tic-tac-toe",
  fresh: () => freshGame(),
  turn: (state) => (asTtt(state).turn === "X" ? "human" : "model"),
  isOver: (state) => isGameOver(asTtt(state)),
  outcome: (state) => {
    const s = asTtt(state);
    if (s.winner === "X") {
      return "human";
    }
    if (s.winner === "O") {
      return "model";
    }
    return s.draw ? "draw" : null;
  },
  status: (state) => statusOf(asTtt(state)),
  systemPrompt: () => gameSystemPrompt(),
  stateForModel: (state) => gameUserPrompt(asTtt(state).board),
  parseMove: (reply, state) => parseModelMove(reply, asTtt(state).board),
  applyMove: (state, move, by) => placeMark(asTtt(state).board, move as number, markFor(by)),
  localMove: (state, by: Player) => bestLocalMove(asTtt(state).board, markFor(by)),
  pass: (state) => {
    const s = asTtt(state);
    return { ...s, turn: s.turn === "X" ? "O" : "X" };
  },
  onKey: (state, key) => onKey(asTtt(state), key),
  render: (state, ctx) => render(asTtt(state), ctx),
};

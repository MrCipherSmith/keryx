// Tic-tac-toe rendering: OpenTUI box/text tree for one board. Rebuilt on
// every paint (the games modal clears the tab body between paints); the board
// is three row boxes of three bordered cell boxes — a single column box would
// stack all nine cells vertically.

import type { GameRenderContext } from "../types";
import type { Mark, TicTacToeState } from "./core";
import { isGameOver } from "./core";
import { resolveCellSize } from "./layout";

function markColor(mark: Mark, theme: Record<string, string>): string {
  return mark === "X" ? (theme.ok ?? "") : (theme.error ?? "");
}

function statusText(state: TicTacToeState): string {
  if (state.winner !== null) {
    return `${state.winner} wins!  (r — new game)`;
  }
  if (state.draw) {
    return "Draw!  (r — new game)";
  }
  return state.turn === "X" ? "Your turn — X" : "Agent's turn — O";
}

export function render(state: TicTacToeState, ctx: GameRenderContext): void {
  const core = ctx.core;
  const r = ctx.renderer;
  const theme = ctx.theme;
  const cellSize = resolveCellSize(ctx.width);

  const wrap = new core.BoxRenderable(r, {
    id: "game-wrap",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
  });

  const legend = new core.BoxRenderable(r, {
    id: "game-legend",
    flexDirection: "row",
    marginBottom: 1,
  });
  legend.add(new core.TextRenderable(r, { id: "game-legend-x", content: "X you", fg: theme.ok }));
  legend.add(new core.TextRenderable(r, { id: "game-legend-sep", content: "  ·  ", fg: theme.muted }));
  legend.add(new core.TextRenderable(r, { id: "game-legend-o", content: "O model", fg: theme.error }));
  wrap.add(legend);

  const board = new core.BoxRenderable(r, {
    id: "game-board",
    flexDirection: "column",
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.panel,
    paddingLeft: 1,
    paddingRight: 1,
  });
  for (let row = 0; row < 3; row++) {
    const rowBox = new core.BoxRenderable(r, {
      id: `game-row-${row}`,
      flexDirection: "row",
      flexShrink: 0,
      gap: 1,
    });
    for (let col = 0; col < 3; col++) {
      const index = row * 3 + col;
      const cell = state.board[index] ?? null;
      const isCursor = index === state.cursor && !isGameOver(state);
      const won = state.winLine?.includes(index) === true;
      const cellBox = new core.BoxRenderable(r, {
        id: `game-cell-${index}`,
        width: cellSize.width,
        height: cellSize.height,
        flexShrink: 0,
        flexGrow: 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        border: true,
        borderStyle: "rounded",
        borderColor: won ? markColor(state.winner ?? "X", theme) : isCursor ? theme.focus : theme.border,
        backgroundColor: isCursor || won ? theme.highlight : undefined,
      });
      const cellText = new core.TextRenderable(r, {
        id: `game-cell-text-${index}`,
        content: cell ?? "·",
        fg: cell === null ? theme.muted : markColor(cell, theme),
      });
      cellBox.add(cellText);
      rowBox.add(cellBox);
    }
    board.add(rowBox);
  }
  wrap.add(board);

  wrap.add(new core.TextRenderable(r, { id: "game-status", content: statusText(state), marginTop: 1 }));
  ctx.parent.add(wrap);
}

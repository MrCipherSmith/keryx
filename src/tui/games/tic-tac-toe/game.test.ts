import { expect, test } from "bun:test";
import type { GameRenderContext } from "../types";
import { ticTacToeGame } from "./game";
import { freshGame, type TicTacToeState } from "./core";

test("GameDefinition turn/outcome/pass contract", () => {
  const g = ticTacToeGame;
  const fresh = g.fresh() as TicTacToeState;
  expect(g.turn(fresh)).toBe("human");
  expect(g.isOver(fresh)).toBe(false);
  expect(g.outcome(fresh)).toBeNull();
  // Human places at centre via onKey enter.
  const afterHuman = g.onKey(fresh, { name: "enter", sequence: "\r" }) as TicTacToeState;
  expect(afterHuman.board[4]).toBe("X");
  expect(g.turn(afterHuman)).toBe("model");
  // Model applies a move.
  const afterModel = g.applyMove(afterHuman, 0, "model") as TicTacToeState;
  expect(afterModel.board[0]).toBe("O");
  expect(g.turn(afterModel)).toBe("human");
  // pass hands the turn back.
  const passed = g.pass(afterHuman) as TicTacToeState;
  expect(passed.turn).toBe("X");
  expect(passed.board).toEqual(afterHuman.board);
});

test("onKey moves the cursor with vim keys and arrows", () => {
  const g = ticTacToeGame;
  const fresh = g.fresh() as TicTacToeState;
  expect(fresh.cursor).toBe(4);
  const up = g.onKey(fresh, { name: "up", sequence: "\u001b[A" }) as TicTacToeState;
  expect(up.cursor).toBe(1);
  const right = g.onKey(up, { name: "l", sequence: "l" }) as TicTacToeState;
  expect(right.cursor).toBe(2);
  const left = g.onKey(right, { name: "h", sequence: "h" }) as TicTacToeState;
  expect(left.cursor).toBe(1);
  const down = g.onKey(left, { name: "j", sequence: "j" }) as TicTacToeState;
  expect(down.cursor).toBe(4);
});

test("GameDefinition renders a 3x3 board into the parent", () => {
  class FakeBox {
    children: unknown[] = [];
    opts: Record<string, unknown>;
    constructor(_r?: unknown, opts: Record<string, unknown> = {}) {
      this.opts = opts;
    }
    add(child: unknown): void {
      this.children.push(child);
    }
    getChildren(): unknown[] {
      return this.children;
    }
  }
  class FakeText {
    content: unknown;
    constructor(_r: unknown, opts: Record<string, unknown>) {
      this.content = opts.content;
    }
  }
  const root = new FakeBox();
  const ctx: GameRenderContext = {
    core: { BoxRenderable: FakeBox as never, TextRenderable: FakeText as never },
    renderer: {},
    theme: { ok: "#1", error: "#2", muted: "#3", border: "#4", panel: "#5", focus: "#6", highlight: "#7" },
    parent: root,
    width: 80,
    height: 24,
  };
  ticTacToeGame.render(ticTacToeGame.fresh(), ctx);
  const boxes: FakeBox[] = [];
  const walk = (node: FakeBox): void => {
    boxes.push(node);
    for (const child of node.children) {
      if (child instanceof FakeBox) {
        walk(child);
      }
    }
  };
  walk(root);
  const cells = boxes.filter((b) => String(b.opts.id).startsWith("game-cell-"));
  expect(cells.length).toBe(9);
});

test("status shows turns and wins", () => {
  const g = ticTacToeGame;
  expect(g.status(g.fresh())).toContain("Your turn — X");
  const fresh = freshGame();
  const won = g.applyMove({ ...fresh, board: ["X", "X", null, "O", "O", null, null, null, null] }, 2, "human") as TicTacToeState;
  expect(won.winner).toBe("X");
  expect(g.status(won)).toContain("X wins!");
  expect(g.outcome(won)).toBe("human");
});

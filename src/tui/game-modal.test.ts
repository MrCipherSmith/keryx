// Headless tests for the /game modal: pure game core + model move + the
// presentGame presentation layer with a fake modal host and a fake provider.
// No OpenTUI, no TTY: `@opentui/core` is only referenced structurally.
import { expect, test } from "bun:test";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";
import {
  checkWinner,
  currentGameState,
  emptyBoard,
  freshGame,
  gameSystemPrompt,
  gameUserPrompt,
  isGameCommand,
  isGameOver,
  modelMove,
  parseModelMove,
  placeMark,
  presentGame,
  resetGame,
  GAME_CELL_GAP,
  GAME_CELL_HEIGHT,
  GAME_CELL_WIDTH,
  type Cell,
} from "./game-modal";
import { getTheme } from "./theme";
import type { ProviderFactory } from "../harness/provider/single-turn";
import type { OpenModalInput } from "./modal-host";

// --- fake provider ----------------------------------------------------------

function stubProvider(reply: string): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub" },
      };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

function factoryFor(reply: string): ProviderFactory {
  return () => stubProvider(reply);
}

/** Let the (synchronous fake) model turn's microtasks settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// --- pure core --------------------------------------------------------------

test("checkWinner finds rows, columns and diagonals", () => {
  expect(checkWinner(["X", "X", "X", null, null, null, null, null, null] as Cell[])?.winner).toBe("X");
  expect(checkWinner([null, null, null, "O", "O", "O", null, null, null] as Cell[])?.winner).toBe("O");
  expect(checkWinner(["X", null, null, null, "X", null, null, null, "X"] as Cell[])?.winner).toBe("X");
  expect(checkWinner([null, null, "O", null, "O", null, "O", null, null] as Cell[])?.winner).toBe("O");
  expect(checkWinner(emptyBoard())).toBeNull();
});

test("placeMark updates turn and detects win", () => {
  const state = placeMark(freshGame().board, 0, "X") ?? freshGame();
  expect(state.board[0]).toBe("X");
  expect(state.turn).toBe("O");

  const win = placeMark(["X", "O", "X", "O", "X", null, null, null, null] as Cell[], 8, "X");
  expect(win?.winner).toBe("X");
  expect(win?.winLine).toEqual([0, 4, 8]);

  // Illegal moves:
  expect(placeMark(["X", null, null, null, null, null, null, null, null] as Cell[], 0, "O")).toBeUndefined();
  expect(placeMark(emptyBoard(), 9, "X")).toBeUndefined();
  expect(placeMark(emptyBoard(), -1, "X")).toBeUndefined();
});

test("draw detection", () => {
  const draw = placeMark(["X", "O", "X", "O", "X", "O", "O", "X", null] as Cell[], 8, "O");
  expect(draw?.winner).toBeNull();
  expect(draw?.draw).toBe(true);
  expect(draw && isGameOver(draw)).toBe(true);
});

test("parseModelMove takes a free cell index only", () => {
  const board = emptyBoard();
  expect(parseModelMove("4", board)).toBe(4);
  expect(parseModelMove("I choose 2", board)).toBe(2);
  expect(parseModelMove("no move", board)).toBeUndefined();
  const occupied: Cell[] = ["X", null, null, null, null, null, null, null, null];
  expect(parseModelMove("0", occupied)).toBeUndefined();
});

test("modelMove uses the injected factory and parses the reply", async () => {
  const result = await modelMove(emptyBoard(), {
    provider: "stub",
    providerFactory: factoryFor("4"),
    env: {},
  });
  expect(result.move).toBe(4);
  expect(result.error).toBeUndefined();
});

test("modelMove fails closed without a credential", async () => {
  const result = await modelMove(emptyBoard(), { env: {} });
  expect(result.move).toBeUndefined();
  expect(result.error).toContain("credential");
});

test("prompts describe the board and the rules", () => {
  expect(gameSystemPrompt()).toContain("0 1 2");
  expect(gameSystemPrompt()).toContain("as O");
  const user = gameUserPrompt(["X", null, null, null, null, null, null, null, null] as Cell[]);
  expect(user).toContain("X . .");
});

test("isGameCommand matches only /game", () => {
  expect(isGameCommand("/game")).toBe(true);
  expect(isGameCommand("  /game ")).toBe(true);
  expect(isGameCommand("/status")).toBe(false);
  expect(isGameCommand("/gamez")).toBe(false);
});

// --- presentGame with fakes -------------------------------------------------

type KeyEvent = { name: string; sequence: string };

class FakeBox {
  children: unknown[] = [];
  readonly id: string | undefined;
  /** The construction options, so layout assertions can read them back. */
  readonly opts: Record<string, unknown>;
  // Repainted in place by `paint()` — these are the cursor/win affordances.
  borderColor: unknown;
  backgroundColor: unknown;

  constructor(_renderer?: unknown, opts: Record<string, unknown> = {}) {
    this.opts = opts;
    this.id = typeof opts.id === "string" ? opts.id : undefined;
    this.borderColor = opts.borderColor;
    this.backgroundColor = opts.backgroundColor;
  }
  add(child: unknown): void {
    this.children.push(child);
  }
  getChildren(): unknown[] {
    return this.children;
  }
  remove(child: unknown): void {
    this.children = this.children.filter((c) => c !== child);
  }
}

class FakeText {
  content: unknown;
  fg: unknown;
  readonly id: string | undefined;

  constructor(_renderer: unknown, opts: Record<string, unknown>) {
    this.content = opts.content;
    this.fg = opts.fg;
    this.id = typeof opts.id === "string" ? opts.id : undefined;
  }
}

const fakeOtui = {
  BoxRenderable: FakeBox,
  TextRenderable: FakeText,
};

interface CapturedModal {
  title?: string;
  tabs?: readonly { id: string; label: string }[];
  onClose?: (() => void) | undefined;
  /** The tab body the host handed to `renderTab`. */
  body?: FakeBox;
}

function fakeHost(captured: CapturedModal) {
  return (_otui: unknown, _chrome: unknown, input: OpenModalInput) => {
    captured.title = input.title;
    captured.tabs = input.tabs;
    captured.onClose = input.onClose;
    const body = new FakeBox();
    captured.body = body;
    input.renderTab("game", body, { width: 80 });
    return {
      close: () => {
        captured.onClose?.();
      },
      setTab: () => {},
      activeTab: () => "game",
    };
  };
}

function openGame(captured: CapturedModal, reply: string): (key: KeyEvent) => void {
  let keyHandler: ((key: KeyEvent) => void) | undefined;
  presentGame(fakeHost(captured), fakeOtui, {}, {
    providerFactory: factoryFor(reply),
    env: {},
    onKeypress: (handler) => {
      keyHandler = handler;
      return () => {};
    },
  });
  return (key) => keyHandler?.(key);
}

/** Every id'd renderable under the tab body, by id. */
function nodes(captured: CapturedModal): { boxes: Map<string, FakeBox>; texts: Map<string, FakeText> } {
  const boxes = new Map<string, FakeBox>();
  const texts = new Map<string, FakeText>();
  const walk = (root: FakeBox): void => {
    for (const child of root.children) {
      if (child instanceof FakeBox) {
        if (child.id !== undefined) {
          boxes.set(child.id, child);
        }
        walk(child);
      } else if (child instanceof FakeText && child.id !== undefined) {
        texts.set(child.id, child);
      }
    }
  };
  const body = captured.body;
  if (body !== undefined) {
    walk(body);
  }
  return { boxes, texts };
}

test("presentGame: user X at center, model O replies, state survives close", async () => {
  resetGame();
  const captured: CapturedModal = {};
  const press = openGame(captured, "0");

  press({ name: "enter", sequence: "\r" });
  await settle();

  const after = currentGameState();
  expect(after.board[4]).toBe("X");
  expect(after.board[0]).toBe("O");
  expect(after.turn).toBe("X");

  // Minimize: close() must NOT reset the game.
  captured.onClose?.();
  expect(currentGameState().board[4]).toBe("X");
  expect(currentGameState().board[0]).toBe("O");

  // Reopen: state is still there (module-level currentGame).
  const captured2: CapturedModal = {};
  openGame(captured2, "1");
  expect(currentGameState().board[4]).toBe("X");

  // Restart resets.
  resetGame();
  expect(currentGameState().board.every((c) => c === null)).toBe(true);
});

test("presentGame: user can drive a full game and win", async () => {
  resetGame();
  const captured: CapturedModal = {};
  const press = openGame(captured, "0"); // model always tries cell 0 (fails when occupied)

  // Cursor starts at center (4). X at 4; model O at 0.
  press({ name: "enter", sequence: "\r" });
  await settle();
  expect(currentGameState().board[4]).toBe("X");

  // Move cursor to cell 2 (up, right) and place X.
  press({ name: "up", sequence: "\u001b[A" });
  press({ name: "right", sequence: "\u001b[C" });
  press({ name: "enter", sequence: "\r" });
  await settle();
  expect(currentGameState().board[2]).toBe("X");

  // Model tries 0 again (occupied) → its move is skipped, turn stays X.
  expect(currentGameState().turn).toBe("X");

  // Move cursor from 2 to 6 (down, down, left, left) and place X → wins [2,4,6].
  press({ name: "down", sequence: "\u001b[B" });
  press({ name: "down", sequence: "\u001b[B" });
  press({ name: "left", sequence: "\u001b[D" });
  press({ name: "left", sequence: "\u001b[D" });
  press({ name: "enter", sequence: "\r" });
  await settle();

  const end = currentGameState();
  expect(end.winner).toBe("X");
  expect(end.winLine).toEqual([2, 4, 6]);
  resetGame();
});

// --- board layout -----------------------------------------------------------

test("presentGame: the board is a 3x3 grid of bordered cells, not one column", () => {
  resetGame();
  const captured: CapturedModal = {};
  openGame(captured, "0");
  const { boxes, texts } = nodes(captured);

  expect(boxes.get("game-wrap")?.opts.alignItems).toBe("center");
  expect(boxes.get("game-board")?.opts.flexDirection).toBe("column");
  expect(boxes.get("game-board")?.opts.border).toBe(true);

  // Three row boxes, each laying its three cells out horizontally. Without
  // these the nine cells stacked into a single 9-row column.
  for (let row = 0; row < 3; row++) {
    const rowBox = boxes.get(`game-row-${row}`);
    expect(rowBox?.opts.flexDirection).toBe("row");
    expect(rowBox?.opts.gap).toBe(GAME_CELL_GAP);
    expect(rowBox?.children.length).toBe(3);
  }

  for (let index = 0; index < 9; index++) {
    const cell = boxes.get(`game-cell-${index}`);
    expect(cell?.opts.border).toBe(true);
    expect(cell?.opts.width).toBe(GAME_CELL_WIDTH);
    expect(cell?.opts.height).toBe(GAME_CELL_HEIGHT);
    expect(cell?.opts.alignItems).toBe("center");
    expect(cell?.opts.justifyContent).toBe("center");
    expect(texts.get(`game-cell-text-${index}`)?.content).toBe("·");
  }
  resetGame();
});

test("presentGame: exactly one cell carries the cursor, and the arrows move it", () => {
  resetGame();
  const captured: CapturedModal = {};
  const press = openGame(captured, "0");
  const { boxes } = nodes(captured);
  const theme = getTheme();
  const cursorCells = (): number[] =>
    [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => boxes.get(`game-cell-${i}`)?.borderColor === theme.focus);

  expect(cursorCells()).toEqual([4]);
  expect(boxes.get("game-cell-4")?.backgroundColor).toBe(theme.highlight);
  expect(boxes.get("game-cell-3")?.backgroundColor).toBeUndefined();

  press({ name: "left", sequence: "\u001b[D" });
  expect(cursorCells()).toEqual([3]);

  press({ name: "up", sequence: "\u001b[A" });
  expect(cursorCells()).toEqual([0]);
  resetGame();
});

test("presentGame: marks paint into their own cell, notice tracks the model turn", async () => {
  resetGame();
  const captured: CapturedModal = {};
  const press = openGame(captured, "0");
  const { texts } = nodes(captured);
  const theme = getTheme();

  press({ name: "enter", sequence: "\r" });
  // Synchronous prefix of the model turn: busy, before the first await.
  expect(texts.get("game-cell-text-4")?.content).toBe("X");
  expect(texts.get("game-cell-text-4")?.fg).toBe(theme.ok);
  expect(texts.get("game-notice")?.content).toBe("agent is thinking…");

  await settle();
  expect(texts.get("game-cell-text-0")?.content).toBe("O");
  expect(texts.get("game-cell-text-0")?.fg).toBe(theme.error);
  expect(texts.get("game-cell-text-1")?.content).toBe("·");
  expect(texts.get("game-notice")?.content).toBe("");
  expect(texts.get("game-status")?.content).toBe("Your turn — X");
  resetGame();
});

test("presentGame: the winning line takes the winner's colour", async () => {
  resetGame();
  const captured: CapturedModal = {};
  const press = openGame(captured, "0");
  const { boxes, texts } = nodes(captured);
  const theme = getTheme();

  press({ name: "enter", sequence: "\r" }); // X at 4, O at 0
  await settle();
  press({ name: "up", sequence: "\u001b[A" });
  press({ name: "right", sequence: "\u001b[C" });
  press({ name: "enter", sequence: "\r" }); // X at 2
  await settle();
  press({ name: "down", sequence: "\u001b[B" });
  press({ name: "down", sequence: "\u001b[B" });
  press({ name: "left", sequence: "\u001b[D" });
  press({ name: "left", sequence: "\u001b[D" });
  press({ name: "enter", sequence: "\r" }); // X at 6 → wins [2,4,6]
  await settle();

  for (const index of [2, 4, 6]) {
    expect(boxes.get(`game-cell-${index}`)?.borderColor).toBe(theme.ok);
    expect(boxes.get(`game-cell-${index}`)?.backgroundColor).toBe(theme.highlight);
  }
  expect(boxes.get("game-cell-1")?.borderColor).toBe(theme.border);
  expect(texts.get("game-status")?.content).toContain("X wins!");
  resetGame();
});

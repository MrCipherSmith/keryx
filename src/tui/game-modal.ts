// Tic-tac-toe vs the model, in the OpenTUI shell.
//
// The user plays X; the model plays O. The game opens as a modal on the shared
// `openModal` host (the same host theme-picker/flow-inspector use), so it
// inherits Esc-close, the tab strip and the key handling for free. Game state
// lives in the module-level closure: closing the modal ("minimizing") keeps the
// board, so a game survives while the main agent keeps working, and re-opening
// `/game` resumes it. `R` starts a fresh game.
//
// The model's move goes through `runModelTurn` (single-turn.ts): one fail-closed
// provider completion, no tools, no policy loop. The provider factory is
// injectable so headless tests drive a fake model without any credential.
// Without a credential the model move reports a clear message and the game
// waits — the user can keep playing local moves / close the modal freely.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005): referenced only
// structurally via `typeof import(...)`, never imported at top level.
import { runModelTurn, type ProviderFactory } from "../harness/provider/single-turn";
import { openModal, type ModalHandle, type OpenModalInput } from "./modal-host";
import { getTheme } from "./theme";

// --- pure game core ---------------------------------------------------------

export type Mark = "X" | "O";
export type Cell = Mark | null;

export const WIN_LINES: readonly (readonly number[])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export interface TicTacToeState {
  board: readonly Cell[];
  turn: Mark;
  winner: Mark | null;
  winLine: readonly number[] | null;
  draw: boolean;
}

export function emptyBoard(): readonly Cell[] {
  return Array<Cell>(9).fill(null);
}

export function checkWinner(board: readonly Cell[]): { winner: Mark; line: readonly number[] } | null {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (a === undefined || b === undefined || c === undefined) {
      continue;
    }
    const mark = board[a];
    if (mark !== null && mark !== undefined && mark === board[b] && mark === board[c]) {
      return { winner: mark, line };
    }
  }
  return null;
}

/** Empty cell indexes, in order. */
export function freeCells(board: readonly Cell[]): number[] {
  return board.flatMap((cell, index) => (cell === null ? [index] : []));
}

/** Place `mark` at `index`; returns the next state, or `undefined` for illegal. */
export function placeMark(
  board: readonly Cell[],
  index: number,
  mark: Mark,
): TicTacToeState | undefined {
  if (index < 0 || index > 8 || board[index] !== null) {
    return undefined;
  }
  const next = board.slice();
  next[index] = mark;
  const win = checkWinner(next);
  const draw = win === null && next.every((cell) => cell !== null);
  return {
    board: next,
    turn: win === null && !draw ? (mark === "X" ? "O" : "X") : mark,
    winner: win?.winner ?? null,
    winLine: win?.line ?? null,
    draw,
  };
}

/** Fresh game state. */
export function freshGame(): TicTacToeState {
  return { board: emptyBoard(), turn: "X", winner: null, winLine: null, draw: false };
}

export function isGameOver(state: TicTacToeState): boolean {
  return state.winner !== null || state.draw;
}

/**
 * Parse the model's move reply into a cell index, or `undefined` when it does
 * not name a free cell. The model may answer with prose around the index, so we
 * take the first standalone digit 0-8; anything else fails closed.
 */
export function parseModelMove(reply: string, board: readonly Cell[]): number | undefined {
  if (reply.length === 0) {
    return undefined;
  }
  const match = /\b([0-8])\b/.exec(reply);
  if (match === null) {
    return undefined;
  }
  const index = Number(match[1]);
  return board[index] === null ? index : undefined;
}

// --- model move -------------------------------------------------------------

/** The system instruction for the model's tic-tac-toe turn. */
export function gameSystemPrompt(): string {
  return [
    "You are playing tic-tac-toe as O against a human playing X.",
    "The board is 9 cells indexed 0..8, row-major:",
    "0 1 2",
    "3 4 5",
    "6 7 8",
    "Reply with ONLY the index of the cell you choose, as a single digit 0-8.",
    "Choose an empty cell. Prefer winning, then blocking, then center/corner.",
  ].join("\n");
}

export function gameUserPrompt(board: readonly Cell[]): string {
  const rows = [0, 1, 2].map((r) => [0, 1, 2].map((c) => board[r * 3 + c] ?? ".").join(" "));
  return `Board (X=you, O=me, .=empty):\n${rows.join("\n")}\n\nMake your move. Reply with one digit 0-8.`;
}

export interface GameModelOptions {
  provider?: string;
  model?: string;
  providerFactory?: ProviderFactory;
  env?: Record<string, string | undefined>;
}

export interface GameModelTurnResult {
  move: number | undefined;
  error: string | undefined;
}

/**
 * Ask the model for its move. Fail-closed: without a credential and without an
 * injected factory, returns an error message instead of throwing. A non-index
 * reply is a skipped turn (move `undefined`, no error).
 */
export async function modelMove(board: readonly Cell[], opts: GameModelOptions = {}): Promise<GameModelTurnResult> {
  const turn = await runModelTurn({
    system: gameSystemPrompt(),
    user: gameUserPrompt(board),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    maxOutputTokens: 16,
    requestId: "keryx-game",
    ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  if (turn.error !== undefined) {
    return { move: undefined, error: `model error: ${turn.error.message}` };
  }
  if (!turn.credentialAvailable && opts.providerFactory === undefined) {
    return { move: undefined, error: "no model credential — configure a provider first (/provider)" };
  }
  return { move: parseModelMove(turn.text, board), error: undefined };
}

// --- modal presentation -----------------------------------------------------

export const GAME_FOOTER = [
  { key: "←↑↓→", label: "move" },
  { key: "enter", label: "place" },
  { key: "r", label: "new game" },
  { key: "esc", label: "minimize" },
] as const;

/** A cell box: one mark centred inside its own rounded border. */
export const GAME_CELL_WIDTH = 5;
export const GAME_CELL_HEIGHT = 3;
/**
 * Columns between two cells in a row; rows themselves sit flush. A terminal
 * cell is roughly twice as tall as it is wide, so one column of horizontal
 * space and zero rows of vertical space read as the *same* visual gap — a
 * symmetric `gap: 1` would stretch the board into a tall rectangle.
 */
export const GAME_CELL_GAP = 1;

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

type OtuiLike = {
  BoxRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Box;
  TextRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Text;
};

function asOtui(otui: unknown): OtuiLike | undefined {
  if (otui === undefined || otui === null) {
    return undefined;
  }
  const cand = otui as Partial<OtuiLike>;
  if (cand.BoxRenderable === undefined || cand.TextRenderable === undefined) {
    return undefined;
  }
  return cand as OtuiLike;
}

export type OpenGameModalFn = (
  otui: unknown,
  chrome: unknown,
  input: OpenModalInput,
) => ModalHandle | undefined;

export interface OpenGameOptions {
  /** Provider/model for the model's move. Omitted → auto-resolve. */
  provider?: string;
  model?: string;
  /** Injected provider factory (tests). */
  providerFactory?: ProviderFactory;
  env?: Record<string, string | undefined>;
  renderer?: unknown;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
}

export interface GameModalHandle {
  close(): void;
  /** Restart the current game. */
  restart(): void;
  /** True while the model is thinking about its move. */
  modelThinking(): boolean;
}

// Module-level game state: survives modal close/reopen (minimize semantics).
let currentGame: TicTacToeState = freshGame();
let modelBusy = false;

export function currentGameState(): TicTacToeState {
  return currentGame;
}

/** Reset the module-level game (used by tests and on `R`). */
export function resetGame(): void {
  currentGame = freshGame();
  modelBusy = false;
}

function markColor(mark: Mark): string {
  return mark === "X" ? getTheme().ok : getTheme().error;
}

function statusText(state: TicTacToeState): string {
  if (state.winner !== null) {
    return `${state.winner} wins!  (r — new game)`;
  }
  if (state.draw) {
    return "Draw!  (r — new game)";
  }
  return `Your turn — ${state.turn}`;
}

/** One board square: the bordered box plus the text node holding its mark. */
type CellView = { box: Box; text: Text };

/**
 * Present the game modal. The single modal host replaces any open modal, so
 * opening `/game` while another inspector is up swaps to the game (and Esc
 * closes back to the transcript). State persists across closes.
 *
 * The board is built ONCE in `renderTab`, as three row boxes of three cell
 * boxes; `paint` then only mutates the retained `CellView`s. An earlier version
 * cleared a single `flexDirection: "column"` box and re-added nine bare text
 * nodes on every keypress, which both flickered and — with no row boxes between
 * the board and the cells — stacked the whole board into one 9-row column
 * instead of a 3×3 grid.
 */
export function presentGame(
  openModalFn: OpenGameModalFn,
  otui: unknown,
  chrome: unknown,
  options: OpenGameOptions = {},
): GameModalHandle | undefined {
  const renderer = options.renderer;
  const core = asOtui(otui);
  let handle: ModalHandle | undefined;
  let cells: CellView[] = [];
  let statusBox: Text | undefined;
  let noticeBox: Text | undefined;
  let cursor = 4;
  /** One-off line under the status (model errors); cleared on the next move. */
  let notice: string | undefined;
  let unsubscribeKey: (() => void) | undefined;

  const paint = (): void => {
    if (statusBox === undefined || noticeBox === undefined || cells.length !== 9) {
      return;
    }
    const theme = getTheme();
    statusBox.content = statusText(currentGame);
    statusBox.fg = theme.text;
    if (modelBusy) {
      noticeBox.content = "agent is thinking…";
      noticeBox.fg = theme.focus;
    } else {
      noticeBox.content = notice ?? "";
      noticeBox.fg = theme.error;
    }
    for (const [index, view] of cells.entries()) {
      const cell = currentGame.board[index] ?? null;
      const isCursor = index === cursor && !isGameOver(currentGame) && !modelBusy;
      const won = currentGame.winLine?.includes(index) === true;
      view.text.content = cell ?? "·";
      view.text.fg = cell === null ? theme.muted : markColor(cell);
      view.box.borderColor = won
        ? markColor(currentGame.winner ?? "X")
        : isCursor
          ? theme.focus
          : theme.border;
      view.box.backgroundColor = isCursor || won ? theme.highlight : undefined;
    }
  };

  const applyModelMove = async (): Promise<void> => {
    if (modelBusy || isGameOver(currentGame) || currentGame.turn !== "O") {
      return;
    }
    modelBusy = true;
    notice = undefined;
    paint();
    const result = await modelMove(currentGame.board, {
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.providerFactory !== undefined ? { providerFactory: options.providerFactory } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    modelBusy = false;
    if (result.move !== undefined) {
      const placed = placeMark(currentGame.board, result.move, "O");
      if (placed !== undefined) {
        currentGame = placed;
      } else {
        // The model named an occupied cell: hand the turn back to the user.
        currentGame = { ...currentGame, turn: "X" };
      }
    } else {
      // Skipped (invalid reply) or errored: never strand the game on "O".
      currentGame = { ...currentGame, turn: "X" };
      // The notice goes through state, not straight onto the text node: the
      // `paint()` two lines down owns that line and would overwrite it.
      notice = result.error === undefined ? undefined : `agent: ${result.error}`;
    }
    paint();
  };

  const userPlace = (): void => {
    if (modelBusy || isGameOver(currentGame) || currentGame.turn !== "X") {
      return;
    }
    const placed = placeMark(currentGame.board, cursor, "X");
    if (placed === undefined) {
      return;
    }
    currentGame = placed;
    notice = undefined;
    paint();
    if (!isGameOver(currentGame) && currentGame.turn === "O") {
      void applyModelMove();
    }
  };

  const moveCursor = (dr: number, dc: number): void => {
    if (modelBusy) {
      return;
    }
    const row = Math.floor(cursor / 3);
    const col = cursor % 3;
    cursor = ((row + dr + 3) % 3) * 3 + ((col + dc + 3) % 3);
    paint();
  };

  const restart = (): void => {
    resetGame();
    cursor = 4;
    notice = undefined;
    paint();
  };

  handle = openModalFn(otui, chrome, {
    title: "/game",
    tabs: [{ id: "game", label: "Tic-tac-toe" }],
    footer: GAME_FOOTER,
    renderTab: (_tabId, body) => {
      if (body === undefined || body === null) {
        return;
      }
      const parent = body as { add?: (child: unknown) => void };
      if (parent.add === undefined || core === undefined) {
        return;
      }
      const theme = getTheme();
      const r = renderer as Renderer;

      // `alignItems: "center"` on a full-width column is what centres the
      // legend, the board and the status as a group. A child `alignSelf`
      // would do it too, but stops that box measuring its own height —
      // see the collapse notes in transcript-blocks.
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
      cells = [];
      for (let row = 0; row < 3; row++) {
        const rowBox = new core.BoxRenderable(r, {
          id: `game-row-${row}`,
          flexDirection: "row",
          flexShrink: 0,
          gap: GAME_CELL_GAP,
        });
        for (let col = 0; col < 3; col++) {
          const index = row * 3 + col;
          const cellBox = new core.BoxRenderable(r, {
            id: `game-cell-${index}`,
            width: GAME_CELL_WIDTH,
            height: GAME_CELL_HEIGHT,
            flexShrink: 0,
            flexGrow: 0,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            border: true,
            borderStyle: "rounded",
            borderColor: theme.border,
          });
          const cellText = new core.TextRenderable(r, {
            id: `game-cell-text-${index}`,
            content: "·",
            fg: theme.muted,
          });
          cellBox.add(cellText);
          rowBox.add(cellBox);
          cells.push({ box: cellBox, text: cellText });
        }
        board.add(rowBox);
      }
      wrap.add(board);

      const status = new core.TextRenderable(r, {
        id: "game-status",
        content: "",
        marginTop: 1,
      });
      statusBox = status;
      wrap.add(status);

      // Kept mounted even while empty: a line that appears and disappears
      // would shift the board as the model takes its turn.
      const noticeText = new core.TextRenderable(r, {
        id: "game-notice",
        content: "",
      });
      noticeBox = noticeText;
      wrap.add(noticeText);

      parent.add(wrap);
      paint();
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      if (token === "up" || token === "k") {
        moveCursor(-1, 0);
        return;
      }
      if (token === "down" || token === "j") {
        moveCursor(1, 0);
        return;
      }
      if (token === "left" || token === "h") {
        moveCursor(0, -1);
        return;
      }
      if (token === "right" || token === "l") {
        moveCursor(0, 1);
        return;
      }
      if (token === "return" || token === "enter" || token === "space" || token === " ") {
        userPlace();
        return;
      }
      if (token === "r" || token === "R") {
        restart();
      }
    });
  }
  return {
    close: () => handle?.close(),
    restart,
    modelThinking: () => modelBusy,
  };
}

/** Open the shared modal host. No-op when OpenTUI / chrome is missing. */
export function openGameModal(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: OpenGameOptions = {},
): GameModalHandle | undefined {
  return presentGame(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

/** True when the line is the game command. */
export function isGameCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === "/game";
}

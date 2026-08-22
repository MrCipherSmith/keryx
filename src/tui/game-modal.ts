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
import { clearTranscriptChildren } from "./transcript-blocks";
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

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

type OtuiLike = {
  BoxRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Box;
  TextRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Text;
  bold?: (value: unknown) => unknown;
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

/**
 * Present the game modal. The single modal host replaces any open modal, so
 * opening `/game` while another inspector is up swaps to the game (and Esc
 * closes back to the transcript). State persists across closes.
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
  let boardBox: Box | undefined;
  let statusBox: Text | undefined;
  let hintBox: Text | undefined;
  let cursor = 4;
  let unsubscribeKey: (() => void) | undefined;

  const paint = (): void => {
    if (core === undefined || boardBox === undefined || statusBox === undefined || hintBox === undefined) {
      return;
    }
    const theme = getTheme();
    clearTranscriptChildren(boardBox);
    statusBox.content = statusText(currentGame);
    hintBox.content = modelBusy ? "agent is thinking…" : "←↑↓→ move · enter place · r new game · esc minimize";
    for (let i = 0; i < 9; i++) {
      const cell = currentGame.board[i] ?? null;
      const isCursor = i === cursor && !isGameOver(currentGame) && !modelBusy;
      const win = currentGame.winLine?.includes(i) === true;
      const content = cell === null ? (isCursor ? "·" : ".") : cell;
      const fg = cell === null ? (isCursor ? theme.focus : theme.muted) : markColor(cell);
      const styled = win && core.bold !== undefined ? core.bold(content) : content;
      boardBox.add(
        new core.TextRenderable(renderer as Renderer, {
          id: `game-cell-${i}`,
          content: styled,
          fg,
        }),
      );
    }
  };

  const applyModelMove = async (): Promise<void> => {
    if (modelBusy || isGameOver(currentGame) || currentGame.turn !== "O") {
      return;
    }
    modelBusy = true;
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
      if (result.error !== undefined) {
        statusBox !== undefined && (statusBox.content = `agent: ${result.error}`);
      }
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

      const board = new core.BoxRenderable(renderer as Renderer, {
        id: "game-board",
        width: 15,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: theme.border,
        backgroundColor: theme.panel,
        paddingLeft: 1,
        paddingRight: 1,
      });
      boardBox = board;
      parent.add(board);

      const status = new core.TextRenderable(renderer as Renderer, {
        id: "game-status",
        content: "",
        marginTop: 1,
      });
      statusBox = status;
      parent.add(status);

      const hint = new core.TextRenderable(renderer as Renderer, {
        id: "game-hint",
        content: "",
        marginTop: 1,
      });
      hintBox = hint;
      parent.add(hint);
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

// Game-module contracts for the /game modal.
//
// A GameDefinition is everything the games modal needs to run one game:
// pure state transitions (fresh/applyMove/isOver), the model-facing prompt
// pair (system + state description), reply parsing, a local fallback move,
// and the OpenTUI rendering. The modal (modal.ts) owns the tab strip, the
// key routing and the model-turn plumbing; a game owns its rules and its
// board. Adding a game = adding one GameDefinition to the registry.

export type Player = "human" | "model";

/** Opaque game state — the game module decides its shape (board, score…). */
export type GameState = unknown;

/** Opaque move — a cell index, a word, whatever the game parses. */
export type GameMove = unknown;

export type GameOutcome = "human" | "model" | "draw" | null;

/** A keypress the modal hands to the active game. */
export interface GameKeyEvent {
  name: string;
  sequence: string;
}

/** The renderer handles the game hands to render into the tab body. */
export interface GameRenderContext {
  /** Structural @opentui/core access (`BoxRenderable`/`TextRenderable`). */
  core: {
    BoxRenderable: new (renderer: unknown, opts: Record<string, unknown>) => { add(child: unknown): void };
    TextRenderable: new (renderer: unknown, opts: Record<string, unknown>) => { content: unknown; fg?: unknown };
  };
  renderer: unknown;
  /** Theme palette (see theme.ts). */
  theme: Record<string, string>;
  /** Parent node the game must append its tree into. */
  parent: { add(child: unknown): void };
  /** Columns available inside the tab body. */
  width: number;
}

export interface GameDefinition {
  /** Stable id, used as the modal tab id. */
  id: string;
  /** Human label for the tab. */
  label: string;

  /** Fresh game state. */
  fresh(): GameState;
  /** Whose turn it is. */
  turn(state: GameState): Player;
  /** Game over? */
  isOver(state: GameState): boolean;
  /** Winner / draw, or null while running. */
  outcome(state: GameState): GameOutcome;
  /** Short status line ("Your turn — X", "O wins!"). */
  status(state: GameState): string;

  /** Stable system instruction for the model's turn. */
  systemPrompt(): string;
  /** The current board / situation, for the user message. */
  stateForModel(state: GameState): string;
  /** Parse the model's reply into a move; undefined = unusable. */
  parseMove(reply: string, state: GameState): GameMove | undefined;
  /** Apply a move; undefined = illegal (caller keeps state). */
  applyMove(state: GameState, move: GameMove, by: Player): GameState | undefined;
  /** A sensible local move for `by`, for timeouts / bad replies. */
  localMove(state: GameState, by: Player): GameMove | undefined;
  /** State with the turn handed back to the other player (model failed). */
  pass(state: GameState): GameState;

  /**
   * Handle a keypress aimed at the game (arrows, enter, vim keys…).
   * Return the next state when the key was consumed, undefined otherwise.
   * `r`/`esc` are reserved for the modal (restart / close).
   */
  onKey(state: GameState, key: GameKeyEvent): GameState | undefined;

  /**
   * Render the board into `ctx.parent`. Called once per tab mount; the game
   * keeps its own node handles and mutates them in a `paint`-style pass.
   */
  render(state: GameState, ctx: GameRenderContext): void;
}

export interface GamesRegistry {
  /** Ordered list of playable games. */
  games: readonly GameDefinition[];
  get(id: string): GameDefinition | undefined;
}


/** Options the modal accepts (provider/model/test injection/timeout). */
export interface GamesModalOptions {
  /** Provider for the model's move. Omitted → auto-resolve. */
  provider?: string;
  model?: string;
  /** Injected provider factory (tests). */
  providerFactory?: import("../../harness/provider/single-turn").ProviderFactory;
  env?: Record<string, string | undefined>;
  /** Model deadline before a local move is played. */
  timeoutMs?: number;
  renderer?: unknown;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
}

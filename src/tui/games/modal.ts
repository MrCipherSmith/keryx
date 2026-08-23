// Games host modal for the /game shell command (flow 174).
//
// One modal, one tab per game. The modal owns the tab strip, the key routing,
// the model-turn plumbing (one fail-closed provider completion per turn, with
// a deadline), and the "agent panel" (see agent-panel.ts): the prompts the
// model sees (system + the per-turn user prompt with the current board) plus
// per-turn latency/token statistics, rendered dim/secondary under the board
// so the operator can watch what the agent work actually costs. The vertical
// budget is shared with the board (see tic-tac-toe/layout.ts): the panel
// takes a fixed minimum, the board gets the rest sized by body height, and
// the prompt card gets the leftover bounded to PROMPT_MIN_ROWS..
// PROMPT_MAX_ROWS — everything is on screen at once, only the prompt card
// ever scrolls, inside itself. Games are pure GameDefinitions (see types.ts)
// — adding a game is adding a definition to the registry.
import { openModal, type ModalHandle, type OpenModalInput } from "../modal-host";
import { getTheme } from "../theme";
import { clearTranscriptChildren } from "../transcript-blocks";
import { createRegistry } from "./registry";
import {
  type GameDefinition,
  type GameKeyEvent,
  type GameRenderContext,
  type GamesModalOptions,
  type GamesRegistry,
  type GameState,
} from "./types";
import { addTurn, emptyTurnTotals, type AgentTurnStats, type AgentTurnTotals } from "./stats";
import { GAME_MODEL_TIMEOUT_MS, GAMES_FOOTER } from "./constants";
import { ticTacToeGame } from "./tic-tac-toe";
import { runGameModelTurn } from "./model-turn";
import { renderAgentPanel } from "./agent-panel";
import { resolveGameBudget } from "./tic-tac-toe/layout";

export const DEFAULT_GAMES: readonly GameDefinition[] = [ticTacToeGame];

import { asOtui, type OtuiLike, type Renderer } from "./otui";

export type OpenGamesModalFn = (
  otui: unknown,
  chrome: unknown,
  input: OpenModalInput,
) => ModalHandle | undefined;

export interface GamesModalHandle {
  close(): void;
  /** Restart the active game. */
  restart(): void;
  /** Id of the currently visible game tab. */
  activeGameId(): string;
  /** True while the model is thinking about its move. */
  modelThinking(): boolean;
}

export function presentGamesModal(
  openModalFn: OpenGamesModalFn,
  otui: unknown,
  chrome: unknown,
  options: GamesModalOptions = {},
  registry: GamesRegistry = createRegistry(DEFAULT_GAMES),
): GamesModalHandle | undefined {
  const games = registry.games;
  const first = games[0];
  if (first === undefined) {
    return undefined;
  }
  const core = asOtui(otui);
  const renderer = options.renderer as Renderer | undefined;
  let handle: ModalHandle | undefined;
  let activeId = first.id;
  const states = new Map<string, GameState>();
  const totals = new Map<string, AgentTurnTotals>();
  const lastTurn = new Map<string, AgentTurnStats | undefined>();
  let notice: string | undefined;
  let modelBusy = false;
  let unsubscribeKey: (() => void) | undefined;
  let bodyRef: { add(child: unknown): void } | undefined;
  let bodyWidth = 0;
  let bodyHeight = 0;
  /** Provider/model in effect; the stats line shows the real one after the first turn. */
  const modelParam = `${options.provider ?? "auto"}/${options.model ?? "auto"}`;

  const stateOf = (id: string): GameState => {
    const game = registry.get(id);
    if (game === undefined) {
      throw new Error(`unknown game: ${id}`);
    }
    let state = states.get(id);
    if (state === undefined) {
      state = game.fresh();
      states.set(id, state);
    }
    return state;
  };

  const totalsOf = (id: string): AgentTurnTotals => {
    let t = totals.get(id);
    if (t === undefined) {
      t = emptyTurnTotals();
      totals.set(id, t);
    }
    return t;
  };

  const paint = (): void => {
    if (core === undefined || bodyRef === undefined) {
      return;
    }
    clearTranscriptChildren(bodyRef as unknown as { getChildren(): unknown[]; remove(child: unknown): void });
    const game = registry.get(activeId);
    if (game === undefined) {
      return;
    }
    const state = stateOf(activeId);
    // Joint board/panel height budget: the board takes the largest cell size
    // that fits bodyHeight − panel minimum; the prompt card gets the leftover.
    const budget = resolveGameBudget(bodyWidth, Math.max(1, bodyHeight));
    const ctx: GameRenderContext = {
      core: core as unknown as GameRenderContext["core"],
      renderer,
      theme: getTheme() as unknown as Record<string, string>,
      parent: bodyRef,
      width: bodyWidth,
      height: budget.boardBudgetRows,
    };
    game.render(state, ctx);
    renderAgentPanel(game, bodyRef, core, renderer as Renderer, {
      notice,
      modelBusy,
      lastTurn: lastTurn.get(activeId),
      totals: totalsOf(activeId),
      userPrompt: game.stateForModel(state),
      promptRows: budget.promptRows,
      modelParam,
    });
  };

  const restart = (): void => {
    const game = registry.get(activeId);
    if (game === undefined) {
      return;
    }
    states.set(activeId, game.fresh());
    totals.set(activeId, emptyTurnTotals());
    lastTurn.set(activeId, undefined);
    notice = undefined;
    paint();
  };

  const applyModelMove = async (): Promise<void> => {
    const game = registry.get(activeId);
    if (game === undefined) {
      return;
    }
    const state = stateOf(activeId);
    if (modelBusy || game.isOver(state) || game.turn(state) !== "model") {
      return;
    }
    modelBusy = true;
    notice = undefined;
    paint();
    const timeoutMs = options.timeoutMs ?? GAME_MODEL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([runGameModelTurn(game, state, options), deadline]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    modelBusy = false;
    const timedOut = outcome === "timeout";
    const result = timedOut ? undefined : outcome;

    let stats: AgentTurnStats;
    if (timedOut) {
      stats = {
        provider: "–",
        model: "–",
        latencyMs: undefined,
        totalMs: timeoutMs,
        inputTokens: undefined,
        outputTokens: undefined,
        reasoning: false,
        localFallback: true,
        error: false,
      };
    } else if (result !== undefined) {
      stats = result.stats;
    } else {
      stats = {
        provider: "–",
        model: "–",
        latencyMs: undefined,
        totalMs: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        reasoning: false,
        localFallback: true,
        error: true,
      };
    }

    let move = result?.move;
    let playedLocally = false;
    if (move === undefined && result?.error === undefined) {
      move = game.localMove(state, "model");
      playedLocally = move !== undefined;
      stats = { ...stats, localFallback: playedLocally };
    }
    const placed = move === undefined ? undefined : game.applyMove(state, move, "model");
    // Never strand the game on the model: hand the turn back.
    const next = placed ?? game.pass(state);

    if (result?.error !== undefined) {
      notice = `agent: ${result.error}`;
    } else if (timedOut && playedLocally) {
      notice = `agent timed out after ${Math.round(timeoutMs / 1000)}s — played a local move`;
    } else if (playedLocally) {
      notice = "agent gave no usable answer — played a local move";
    } else {
      notice = undefined;
    }
    states.set(activeId, next);
    totals.set(activeId, addTurn(totalsOf(activeId), stats));
    lastTurn.set(activeId, stats);
    paint();
  };

  handle = openModalFn(otui, chrome, {
    title: "/game",
    tabs: games.map((game) => ({ id: game.id, label: game.label })),
    footer: GAMES_FOOTER,
    // Left/right go to the active game FIRST. The modal host's own tab switch
    // would otherwise consume both arrows and stopPropagation them, so the
    // game's onKeypress handler below would never see them — the cursor moved
    // up/down but not sideways (regression of the 0.2.60 fix: the multi-tab
    // games-host split of flow 174 dropped the onArrowKeys claim the legacy
    // game-modal.ts keeps). This hook is a pure probe: it only answers "does
    // the active game want this key?" so the host declines to switch tabs.
    // The move itself is applied by the onKeypress handler below — applying it
    // here too would move the cursor twice per press, because a claimed key is
    // not stopPropagation'd and both listeners receive it.
    onArrowKeys: (key, _direction) => {
      const game = registry.get(activeId);
      if (game === undefined || modelBusy) {
        return false;
      }
      const state = stateOf(activeId);
      return game.onKey(state, { name: key.name, sequence: key.sequence }) !== undefined;
    },
    renderTab: (_tabId, body, ctx) => {
      if (body === undefined || body === null) {
        return;
      }
      bodyRef = body as { add(child: unknown): void };
      bodyWidth = ctx.width;
      bodyHeight = ctx.height;
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
    unsubscribeKey = options.onKeypress((key: GameKeyEvent) => {
      const token = key.name || key.sequence;
      if (token === "r" || token === "R") {
        restart();
        return;
      }
      const game = registry.get(activeId);
      if (game === undefined || modelBusy) {
        return;
      }
      const state = stateOf(activeId);
      const next = game.onKey(state, key);
      if (next === undefined) {
        return;
      }
      states.set(activeId, next);
      paint();
      if (!game.isOver(next) && game.turn(next) === "model") {
        void applyModelMove();
      }
    });
  }
  return {
    close: () => handle?.close(),
    restart,
    activeGameId: () => activeId,
    modelThinking: () => modelBusy,
  };
}

export function openGamesModal(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: GamesModalOptions = {},
): GamesModalHandle | undefined {
  return presentGamesModal(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

export function isGameCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === "/game";
}

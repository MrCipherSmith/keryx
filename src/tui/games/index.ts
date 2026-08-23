// Games module entry: the /game modal as a multi-tab games host.
export { openGamesModal, presentGamesModal, isGameCommand, DEFAULT_GAMES } from "./modal";
export type { GamesModalHandle } from "./modal";
export { runGameModelTurn } from "./model-turn";
export type { GamesModelTurnResult } from "./model-turn";
export { renderAgentPanel } from "./agent-panel";
export { createRegistry } from "./registry";
export { GAME_MODEL_TIMEOUT_MS, GAMES_FOOTER } from "./constants";
export { addTurn, emptyTurnTotals, formatMs, formatTokens } from "./stats";
export type { AgentTurnStats, AgentTurnTotals } from "./stats";
export { ticTacToeGame } from "./tic-tac-toe";
export type { GameDefinition, GameState, GameMove, GameKeyEvent, GameRenderContext, GamesRegistry, GamesModalOptions, Player } from "./types";

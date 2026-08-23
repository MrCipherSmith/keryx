// Tic-tac-toe module: one GameDefinition + its public pieces.
export { ticTacToeGame } from "./game";
export { checkWinner, emptyBoard, freshGame, freeCells, isGameOver, bestLocalMove, parseModelMove, placeMark, asTtt } from "./core";
export type { Mark, Cell, TicTacToeState } from "./core";
export { gameSystemPrompt, gameUserPrompt } from "./prompts";
export { GAME_CELL_GAP, GAME_BOARD_CHROME_X, GAME_CELL_SIZES, gameBoardWidth, resolveCellSize } from "./layout";

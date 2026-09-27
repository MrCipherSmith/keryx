---
Title: Module src/tui/games/tic-tac-toe
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/tui/games/tic-tac-toe` groups 11 file(s). Depends on `src/tui/games`. Exposes 17 public symbol(s)."
---
```markdown
---
Title: Module src/tui/games/tic-tac-toe
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/tui/games/tic-tac-toe` groups 11 file(s). Depends on `src/tui/games`. Exposes 17 public symbol(s)."
---

# Module src/tui/games/tic-tac-toe

## Summary

`src/tui/games/tic-tac-toe` provides a self-contained Tic-Tac-Toe game component for the TUI layer. It groups 11 files, depends on `src/tui/games`, and exposes 17 public symbols.

## Overview

The module implements Tic-Tac-Toe as a reusable TUI game component. It owns:

- Game board state and logic
- Win/draw detection rules
- Presentation geometry and layout
- Prompt helpers for model-assisted play

Its role is to provide a composable Tic-Tac-Toe implementation that integrates with the broader games area via `src/tui/games`.

## How It Works

The module is organized around several cooperating layers:

### Rules and State (`core.ts`)

- `emptyBoard` and `freshGame` create the initial board state
- `placeMark` applies a move to the board
- `freeCells` exposes cells that can still be played
- `checkWinner` and `isGameOver` determine whether the game has ended

### Game Packaging and Export (`game.ts`, `index.ts`)

- `ticTacToeGame` is the public game entry used by the games area
- `index.ts` aggregates the public API and is the module's entry point

### Presentation Geometry (`layout.ts`)

- `GAME_CELL_GAP`, `GAME_BOARD_CHROME_X`, and `GAME_CELL_SIZES` describe the board's visual structure
- `gameBoardWidth` and `resolveCellSize` translate board state into renderable dimensions

### Rendering (`render.ts`)

- Draws the board and marks using the layout model
- Focuses on visual presentation rather than game rules

### Model-Assisted Play (`prompts.ts`)

- `gameSystemPrompt` and `gameUserPrompt` provide prompt text for model-assisted move selection
- `parseModelMove` normalizes model output into a usable move representation
- `bestLocalMove` supports local move selection or fallback behavior

## Key Concepts

### Board

- The 3×3 playing surface used by the game
- Created with `emptyBoard` or `freshGame` and updated through `placeMark`

### Cell and Mark

- A cell is a board position that may contain a player mark or remain empty
- `freeCells` identifies playable cells

### Winner and Game-Over State

- `checkWinner` determines whether a winning line exists
- `isGameOver` determines whether play should stop, either due to a win or a draw

### Local Move

- A move selected without external model input
- `bestLocalMove` contributes to local move selection or fallback behavior

### Model Move

- A move suggested by an external model and then normalized through `parseModelMove`

### Layout

- The geometry mapping logical board cells to TUI coordinates
- Represented through constants: `GAME_CELL_GAP`, `GAME_BOARD_CHROME_X`, `GAME_CELL_SIZES`
- Computed via helpers: `gameBoardWidth`, `resolveCellSize`

### Game Entry

- `ticTacToeGame` is the public object that makes this game available to `src/tui/games`

## Main Flows

### Start or Reset a Game

1. A caller begins or resets play through the module's public entry point or `ticTacToeGame`
2. `freshGame` and `emptyBoard` create a clean starting board
3. The surrounding game UI renders the board using layout helpers and `render.ts`

### Apply a Local Move

1. The surrounding TUI controller selects a target cell from the current board state
2. `freeCells` determines whether the selected cell is still playable
3. `placeMark` applies the move to the board
4. `checkWinner` and `isGameOver` evaluate whether the move ended the game

### Request a Model-Assisted Move

1. `gameSystemPrompt` and `gameUserPrompt` prepare prompt text describing the game context
2. A model response is passed to `parseModelMove` to obtain a usable move
3. If the move is valid, it is applied through `placeMark`
4. If model input is unavailable or invalid, `bestLocalMove` provides a local fallback move

---

## Reference

Extracted by `keryx wiki collect`; regenerated with `--force`. The prose sections above are the agent/human-owned part.

### Public API

| Symbol | Description |
|--------|-------------|
| `ticTacToeGame` | Public game entry point |
| `checkWinner` | Determines if a winning line exists |
| `emptyBoard` | Creates an empty board state |
| `freshGame` | Creates a fresh game state |
| `freeCells` | Lists playable cells |
| `isGameOver` | Checks terminal game state |
| `bestLocalMove` | Local move selection or fallback |
| `parseModelMove` | Normalizes model output to a move |
| `placeMark` | Applies a move to the board |
| `asTtt` | Type conversion utility |
| `gameSystemPrompt` | System prompt for model-assisted play |
| `gameUserPrompt` | User prompt for model-assisted play |
| `GAME_CELL_GAP` | Layout constant for cell spacing |
| `GAME_BOARD_CHROME_X` | Layout constant for board chrome |
| `GAME_CELL_SIZES` | Layout constant for cell dimensions |
| `gameBoardWidth` | Computes board width |
| `resolveCellSize` | Resolves cell size for rendering |

### Key Files

| File | Imports | Exports |
|------|---------|---------|
| `src/tui/games/tic-tac-toe/core.ts` | 1 | 8 |
| `src/tui/games/tic-tac-toe/game.ts` | 5 | 2 |
| `src/tui/games/tic-tac-toe/index.ts` | 4 | 3 |
| `src/tui/games/tic-tac-toe/layout.ts` | 1 | 5 |
| `src/tui/games/tic-tac-toe/prompts.ts` | 1 | 3 |
| `src/tui/games/tic-tac-toe/render.ts` | 3 | 1 |

### Dependencies

- **Depends on:** `src/tui/games` (7 imports)
- **Depended on by:** `src/tui/games` (5 imports)

### Entry Points

- `src/tui/games/tic-tac-toe/index.ts`

### Graph Signals

- **Files:** 11
- **Cross-module imports:** 7

## Related Pages

- [Wiki Index](../index.md)
- [Module src/tui/games](src-tui-games.md)

## Changelog

- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections reviewed and enriched.
```

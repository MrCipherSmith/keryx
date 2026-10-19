---
Title: Module src/tui/games/tic-tac-toe
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/tui/games/tic-tac-toe` groups 11 file(s). Depends on `src/tui/games`. Exposes 17 public symbol(s)."
---
```markdown
---
Title: Module src/tui/games/tic-tac-toe
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/tui/games/tic-tac-toe` groups 11 file(s). Depends on `src/tui/games`. Exposes 17 public symbol(s)."
---

# Module src/tui/games/tic-tac-toe

## Summary

`src/tui/games/tic-tac-toe` implements Tic-tac-toe as one `GameDefinition` for the TUI games area, with the human playing X and the model playing O. It keeps board rules pure, turns model replies into moves, and sizes and renders the board to fit its modal body.

## Overview

This module owns the Tic-tac-toe game for the TUI games area: the board rules (placing marks, detecting wins and draws), the prompts and reply parsing used when the model plays O, the board geometry, and the OpenTUI rendering of the board. `ticTacToeGame` in `game.ts` wires these pieces into the shared game contract that `src/tui/games` drives, and `index.ts` is the public entry point.

## How It Works

The code is split into layers. The rule layer knows nothing about rendering or prompts, and `game.ts` is the only place that connects the layers to the shared game contract.

### Rules and State (`core.ts`)

`core.ts` is pure logic. `TicTacToeState` holds the board, the side to move, the winner and winning line, a `draw` flag and a cursor. `placeMark` returns a new state instead of mutating the board. It returns `undefined` for an out-of-range or occupied cell, and it switches `turn` only while play continues. `checkWinner` scans the eight `WIN_LINES`, and `isGameOver` treats a win or a draw as terminal. `bestLocalMove` is a fixed heuristic: take a winning cell, block the opponent's winning cell, then prefer the centre, then corners, then the first free cell.

### Game Packaging and Export (`game.ts`, `index.ts`)

`game.ts` exports `ticTacToeGame`, a `GameDefinition` with the id `tic-tac-toe`. Its `turn` returns `"human"` for X and `"model"` for O, and its `outcome` maps an X win to human, an O win to model, and a full draw to `"draw"`. `pass` only flips the turn without placing a mark. Key handling is delegated to `./input` (`onKey`, `markFor`), which lies outside the Key files list, and rendering is delegated to `render.ts`. `index.ts` re-exports the public pieces and is the module entry point.

### Presentation Geometry (`layout.ts`)

`layout.ts` maps the board onto terminal cells. `GAME_CELL_SIZES` has four sizes, from large to tiny. The horizontal gap is one column and the vertical gap is zero rows, because a terminal cell is roughly twice as tall as it is wide. `gameBoardWidth` and `boardRegionRows` compute the footprint, and `resolveCellSize` picks the largest size that fits. `resolveGameBudget` splits a modal body's rows between the board region, the prompt card (bounded by `PROMPT_MIN_ROWS` and `PROMPT_MAX_ROWS`), and the agent panel's minimum.

### Rendering (`render.ts`)

`render` rebuilds the OpenTUI box tree on every paint. It resolves the cell size from the context width and height, and draws three rows of three bordered cells. The cursor cell gets the focus border, a winning line takes the winner's colour, and a status line is added below the board. It reads state but never decides rules.

### Model-Assisted Play (`prompts.ts`)

`gameSystemPrompt` tells the model that it plays O and must reply with one digit from 0 to 8. `gameUserPrompt` renders the board as a 3×3 grid with `X`, `O` and `.` for empty cells. `parseModelMove` takes the first standalone digit 0 to 8 from the reply and accepts it only if that cell is empty, so unusable replies fail closed. When no model move is usable, the fallback is `bestLocalMove` in `core.ts`.

## Key Concepts

### Board

- A `readonly Cell[]` of nine entries in row-major order, indexed 0 to 8
- `emptyBoard` and `freshGame` create it, and `placeMark` returns an updated copy rather than changing the original

### Cell and Mark

- A `Cell` is either a `Mark` (`"X"` for the human, `"O"` for the model) or `null` for an empty cell
- `freeCells` lists the indices that are still `null`

### Winner and Game-Over State

- `checkWinner` returns the winning mark and its line, or `null`
- `isGameOver` is true when there is a winner or the `draw` flag is set. `draw` is set only when the board is full and no line won

### Local Move

- A move chosen by `bestLocalMove` without model input
- Exposed to the games contract as `localMove` in `game.ts`. It appears to serve as the fallback when no model move is usable

### Model Move

- A reply from the model, turned into a cell index by `parseModelMove`. A reply with no digit or an occupied cell yields `undefined`

### Layout

- The geometry that maps logical board cells to terminal size
- Constants: `GAME_CELL_GAP`, `GAME_BOARD_CHROME_X`, `GAME_CELL_SIZES`
- Helpers: `gameBoardWidth`, `resolveCellSize`, and the budget function `resolveGameBudget`

### Game Entry

- `ticTacToeGame` is the `GameDefinition` (id `tic-tac-toe`, label "Tic-tac-toe") that `src/tui/games` consumes

## Main Flows

### Start or Reset a Game

1. The games area calls `ticTacToeGame.fresh`, which calls `freshGame`
2. `freshGame` builds an empty board with `emptyBoard`, sets `turn` to `"X"`, and places the cursor on cell 4, the centre
3. `render` draws the board, using `resolveCellSize` to choose the cell size from the available width and height

### Apply a Move

1. The games area calls `applyMove` with a cell index and the player, and `applyMove` converts the player to a mark with `markFor`
2. `placeMark` returns `undefined` for an occupied or out-of-range cell. Otherwise it returns a new state with the mark placed and `winner`, `winLine` and `draw` computed
3. `turn` switches only while play continues, and `isOver` reports the terminal state through `isGameOver`
4. `outcome` maps a win to `"human"` or `"model"`, a draw to `"draw"`, and anything else to `null`

### Request a Model-Assisted Move

1. `systemPrompt` and `stateForModel` supply the system prompt and a board-based user prompt through `gameSystemPrompt` and `gameUserPrompt`
2. The model's reply goes to `parseMove`, which calls `parseModelMove` to get a usable index
3. A valid index is applied through `placeMark`
4. If the reply is unusable, `bestLocalMove` provides the fallback through `localMove`

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

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections reviewed and enriched.
```

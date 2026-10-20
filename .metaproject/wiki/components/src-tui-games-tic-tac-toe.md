---
Title: Module src/tui/games/tic-tac-toe
Version: 1.0.2
Type: component
Status: accepted
VerifiedScope: sha256:3d9e9e928fd41c0151120c37e9402f742d4015e37b1b9acb1d4b1f3d77efcb75
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

<!-- keryx:reference:begin v=1 hash=2c25bf9ed1c9f9ca68fbf9db8ab458dc92142428b2f61e7c443f9ad91618fcc2 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `ticTacToeGame`
- `checkWinner`
- `emptyBoard`
- `freshGame`
- `freeCells`
- `isGameOver`
- `bestLocalMove`
- `parseModelMove`
- `placeMark`
- `asTtt`
- `gameSystemPrompt`
- `gameUserPrompt`
- `GAME_CELL_GAP`
- `GAME_BOARD_CHROME_X`
- `GAME_CELL_SIZES`
- `gameBoardWidth`
- `resolveCellSize`

### Key files

- `src/tui/games/tic-tac-toe/core.ts` - imported by 8, imports 1
- `src/tui/games/tic-tac-toe/game.ts` - imported by 2, imports 5
- `src/tui/games/tic-tac-toe/index.ts` - imported by 3, imports 4
- `src/tui/games/tic-tac-toe/layout.ts` - imported by 5, imports 1
- `src/tui/games/tic-tac-toe/prompts.ts` - imported by 3, imports 1
- `src/tui/games/tic-tac-toe/render.ts` - imported by 1, imports 3

### Depends on

- `src/tui/games` - 5 import(s)

### Depended on by

- `src/tui/games` - 3 import(s)

### Dependency basis

- Production imports only: 4 import(s) from test file(s) (e.g. `src/tui/games/modal.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/tui/games/tic-tac-toe/index.ts`

### Graph signals

- Files: 11
- Cross-module imports: 5
<!-- keryx:reference:end -->

## Related Pages

- [Wiki Index](../index.md)
- [Module src/tui/games](src-tui-games.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.1 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections reviewed and enriched.

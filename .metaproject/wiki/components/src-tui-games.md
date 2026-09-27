---
Title: Module src/tui/games
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/tui/games` groups terminal UI game features, including game modal presentation, game selection, model turn helpers, agent panel rendering, and shared game types/constants. It exposes 14 public symbols and coordinates with `src/tui`, `src/harness/provider`, and `src/tui/games/tic-tac-toe`."
---
```markdown
---
Title: Module src/tui/games
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/tui/games` is the terminal UI package for game-related commands and presentation. It groups 12 files and exposes 14 public symbols for opening and presenting a games modal, identifying game commands, running game-model turns, rendering an agent panel, and formatting turn statistics."
---

# Module src/tui/games

## Overview

`src/tui/games` provides the terminal UI layer for game-related commands and presentation within the TUI shell. It connects user input to game state by coordinating:

- Game modal lifecycle (open/present)
- Game command recognition
- Model-backed turn execution
- Agent panel rendering
- Turn statistics formatting

The module relies on `src/tui` for terminal integration, `src/harness/provider` for model-facing behavior, and `src/tui/games/tic-tac-toe` for a concrete game implementation.

## Architecture

The package organizes functionality across focused files:

| File | Responsibility |
|------|-----------------|
| `index.ts` | Public API entry point; exposes 14 symbols |
| `types.ts` | Shared game contracts; most widely imported file |
| `constants.ts` | Default games, footer text, timeout config |
| `modal.ts` | Main coordination point; imports 12 files |
| `agent-panel.ts` | Renders agent/model response area |
| `modal.test.ts` | Integration tests; imports 10 files |

### Entry point

`src/tui/games/index.ts` exposes the module's public API to consumers.

### Shared contracts

`src/tui/games/types.ts` defines shapes used across the package and serves as the central contract layer.

### Stable values

`src/tui/games/constants.ts` provides:

- `DEFAULT_GAMES` — list of available games
- `GAMES_FOOTER` — shared footer text
- `GAME_MODEL_TIMEOUT_MS` — timeout for model calls

### Coordination

`src/tui/games/modal.ts` is the main integration point, connecting command recognition, game selection, presentation helpers, and game-specific implementations.

## Key Concepts

### Games modal

A terminal UI surface for presenting game options or active game state. Two public helpers manage the lifecycle:

- `openGamesModal` — initializes the modal
- `presentGamesModal` — renders and displays it

### Game command

User input classified as game-related via `isGameCommand`. Command classification is kept separate from rendering logic.

### Game registry

A container for available games. Use `createRegistry` to build one; `DEFAULT_GAMES` and `ticTacToeGame` provide built-in entries.

### Game model turn

A model-backed turn execution, handled by `runGameModelTurn`. Timeouts are configured via `GAME_MODEL_TIMEOUT_MS`.

### Agent panel

A UI component that displays model or agent responses during game interactions, rendered via `renderAgentPanel`.

### Turn statistics

Lightweight metadata tracking for game sessions:

- `emptyTurnTotals` — initializes counters
- `addTurn` — records a turn
- `formatMs` — formats durations
- `formatTokens` — formats token counts

## Main Flows

### Opening the games modal

1. User issues a game-related command
2. `isGameCommand` classifies the input
3. `openGamesModal` initializes the modal
4. `presentGamesModal` renders it using:
   - Game definitions from `DEFAULT_GAMES`
   - Registry from `createRegistry`
   - `ticTacToeGame` as the demo game
   - `GAMES_FOOTER` for footer content

### Running a model-backed turn

1. Game requires model interaction
2. `runGameModelTurn` executes with timeout from `GAME_MODEL_TIMEOUT_MS`
3. `src/harness/provider` supplies the model-facing behavior
4. Results rendered via `renderAgentPanel`
5. Turn tracked via `addTurn` using `emptyTurnTotals` for initialization
6. Display formatted with `formatMs` and `formatTokens`

### Tic-tac-toe integration

`src/tui/games/tic-tac-toe` has a bidirectional relationship with this module:

- **Consumes** shared contracts from `src/tui/games/types.ts` and presentation helpers
- **Provides** `ticTacToeGame` back to the games registry

## Reference

### Public API

- `openGamesModal`
- `presentGamesModal`
- `isGameCommand`
- `DEFAULT_GAMES`
- `runGameModelTurn`
- `renderAgentPanel`
- `createRegistry`
- `GAME_MODEL_TIMEOUT_MS`
- `GAMES_FOOTER`
- `addTurn`
- `emptyTurnTotals`
- `formatMs`
- `formatTokens`
- `ticTacToeGame`

### Key files by reach

| File | Imported by | Imports |
|------|-------------|---------|
| `modal.ts` | 3 | 12 |
| `types.ts` | 11 | 1 |
| `modal.test.ts` | 0 | 10 |
| `index.ts` | 1 | 8 |
| `agent-panel.ts` | 2 | 3 |
| `constants.ts` | 5 | 0 |

### Dependencies

- `src/tui` — 6 imports (terminal UI integration)
- `src/harness/provider` — 6 imports (model-facing behavior)
- `src/tui/games/tic-tac-toe` — 5 imports (game implementation)

### Dependents

- `src/tui/games/tic-tac-toe` — 7 imports
- `src/tui` — 1 import

### Module metrics

- Files: 12
- Cross-module imports: 17
- Entry point: `src/tui/games/index.ts`

## Related Pages

- [Wiki Index](../index.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/tui/games/tic-tac-toe](src-tui-games-tic-tac-toe.md)

## Changelog

- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```

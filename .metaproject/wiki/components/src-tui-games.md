---
Title: Module src/tui/games
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/tui/games` groups terminal UI game features, including game modal presentation, game selection, model turn helpers, agent panel rendering, and shared game types/constants. It exposes 14 public symbols and coordinates with `src/tui`, `src/harness/provider`, and `src/tui/games/tic-tac-toe`."
---

# Module src/tui/games

## Summary

`src/tui/games` is the terminal UI package for game-related commands and presentation. It groups 12 files and exposes 14 public symbols for opening and presenting a games modal, identifying game commands, running game-model turns, rendering an agent panel, and formatting turn statistics.

The module acts as the bridge between the TUI shell and game implementations. It provides the shared contracts, defaults, and presentation helpers used by game surfaces, while relying on `src/tui` for terminal UI integration, `src/harness/provider` for model-backed behavior, and `src/tui/games/tic-tac-toe` for a concrete game example.

## Overview

This module owns the user-facing “games” area inside the TUI. It turns game-related input into modal UI state, keeps game definitions available through default lists and a registry, and supports a tic-tac-toe game integration.

Its main purpose is to connect the terminal shell with model-backed game flows while keeping shared game types, constants, registry creation, turn accounting, and formatting helpers in one place.

## How it works

The package is organized around a small set of responsibilities:

- **Public entry point**  
  `src/tui/games/index.ts` exposes the module’s public API to the rest of the app.

- **Shared contracts**  
  `src/tui/games/types.ts` defines shared game-related shapes used across the package. It is one of the most widely imported files in the module, indicating it is a central contract layer.

- **Shared constants**  
  `src/tui/games/constants.ts` stores stable values such as default games, footer text, and model timeout configuration.

- **Modal coordination**  
  `src/tui/games/modal.ts` imports many other files and is likely the main coordination point for the games modal. It connects command recognition, game selection, presentation helpers, and game-specific integrations.

- **Agent panel rendering**  
  `src/tui/games/agent-panel.ts` provides rendering for an agent panel used during game-related model interactions.

- **Tests**  
  `src/tui/games/modal.test.ts` covers modal behavior and imports from most of the module, reinforcing `modal.ts` as a central integration point.

Dependencies are focused and intentional:

- `src/tui` provides terminal UI integration.
- `src/harness/provider` supplies provider or model-facing services.
- `src/tui/games/tic-tac-toe` supplies the tic-tac-toe game implementation and related game contracts.

## Key concepts

- **Games modal**  
  A terminal UI surface for presenting game options or game state. Public helpers such as `openGamesModal` and `presentGamesModal` indicate that modal lifecycle and presentation are separated.

- **Game command**  
  A game-related user command recognized through `isGameCommand`. This keeps command classification separate from rendering.

- **Game registry**  
  A container for available games. `createRegistry`, `DEFAULT_GAMES`, and `ticTacToeGame` suggest that games are represented as first-class entries that the modal can display or dispatch.

- **Game model turn**  
  A model-backed turn or action associated with a game. `runGameModelTurn` and `GAME_MODEL_TIMEOUT_MS` indicate that game interactions may depend on provider calls with bounded execution time.

- **Agent panel**  
  A UI area associated with model or agent responses. `renderAgentPanel` is exported by this module, suggesting it is used within game flows to display model output.

- **Turn totals and formatting**  
  Helpers such as `addTurn`, `emptyTurnTotals`, `formatMs`, and `formatTokens` indicate that game sessions track lightweight turn metadata and present it in user-facing form.

## Main flows

### Opening the games modal

A game-related command enters the TUI and is recognized through `isGameCommand`. The games module opens the games modal using `openGamesModal`, then presents it using `presentGamesModal`. During presentation, the module uses available game definitions, likely sourced from `DEFAULT_GAMES`, `createRegistry`, and the `ticTacToeGame` export, to render the game selection surface. `GAMES_FOOTER` provides shared footer content for the modal.

### Running a model-backed game turn

When a game requires model interaction, the module uses `runGameModelTurn`. The provider dependency on `src/harness/provider` supplies the model-facing behavior, while `GAME_MODEL_TIMEOUT_MS` bounds the operation duration. Results or agent output can be rendered through `renderAgentPanel`. Turn accounting is tracked using `emptyTurnTotals` and `addTurn`, with `formatMs` and `formatTokens` used for display-oriented summaries.

### Integrating tic-tac-toe

`src/tui/games/tic-tac-toe` is both a dependency and a dependent of this package. The tic-tac-toe implementation consumes shared contracts and presentation helpers from `src/tui/games`, while also providing `ticTacToeGame` back into the broader games surface. This creates a close relationship: the parent module defines the shared game contract, and the tic-tac-toe package supplies a concrete game implementation that fits that contract.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

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

### Key files

- `src/tui/games/modal.ts` - imported by 3, imports 12
- `src/tui/games/types.ts` - imported by 11, imports 1
- `src/tui/games/modal.test.ts` - imported by 0, imports 10
- `src/tui/games/index.ts` - imported by 1, imports 8
- `src/tui/games/agent-panel.ts` - imported by 2, imports 3
- `src/tui/games/constants.ts` - imported by 5, imports 0

### Depends on

- `src/tui` - 6 import(s)
- `src/harness/provider` - 6 import(s)
- `src/tui/games/tic-tac-toe` - 5 import(s)

### Depended on by

- `src/tui/games/tic-tac-toe` - 7 import(s)
- `src/tui` - 1 import(s)

### Entry points

- `src/tui/games/index.ts`

### Graph signals

- Files: 12
- Cross-module imports: 17

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/tui/games/tic-tac-toe](src-tui-games-tic-tac-toe.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.

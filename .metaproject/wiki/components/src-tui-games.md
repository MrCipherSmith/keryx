---
Title: Module src/tui/games
Version: 1.0.2
Type: component
Status: accepted
VerifiedScope: sha256:afd37004f0bea9f4a8a225c335d563014957529eeb7f27f72433f0afc47a0741
Summary: "`src/tui/games` groups terminal UI game features, including game modal presentation, game selection, model turn helpers, agent panel rendering, and shared game types/constants. It exposes 14 public symbols and coordinates with `src/tui`, `src/harness/provider`, and `src/tui/games/tic-tac-toe`."
---
# Module src/tui/games

## Overview

`src/tui/games` is the terminal UI package behind the `/game` shell command. It hosts a tabbed games modal, recognises game commands, runs model-backed turns for the active game and shows what those turns cost in time and tokens. The package does not own board rules: each game is a `GameDefinition` plugged into a registry, and the reference game is `ticTacToeGame` in `src/tui/games/tic-tac-toe`.

## How it works

The package has one composition point and a set of pluggable contracts. `modal.ts` (`presentGamesModal`) is the only file that wires the rest together. It opens a single modal through `openModal` from `src/tui/modal-host`, creates one tab per registered game, routes keys, and drives the model turn.

The boundary is the `GameDefinition` interface in `types.ts`. A game supplies pure state transitions (`fresh`, `turn`, `isOver`, `applyMove`), the model-facing prompt pair (`systemPrompt`, `stateForModel`), reply parsing (`parseMove`), fallback moves (`localMove`, `pass`), key handling (`onKey`) and rendering (`render`). The modal only sees that interface, so adding a game means adding one definition to a registry built by `createRegistry` in `registry.ts`.

The agent panel in `agent-panel.ts` is a view with no state of its own. `renderAgentPanel` draws a status card (notice, provider/model, last-turn and session totals) and a bounded, scrollable prompt card that shows the per-turn user prompt before the system prompt. Statistics are plain data in `stats.ts`: each turn yields an `AgentTurnStats`, which `addTurn` folds into `AgentTurnTotals`. `constants.ts` holds the model deadline (`GAME_MODEL_TIMEOUT_MS`, 60 seconds), the footer hints and the row budget (`PANEL_FIXED_ROWS`, `PROMPT_MIN_ROWS`, `PROMPT_MAX_ROWS`). The modal splits the body height between the board and the panel with `resolveGameBudget` from `tic-tac-toe/layout`, so both fit on screen without modal-level scrolling.

## Key concepts

### Games modal

A tabbed modal titled `/game`, with one tab per game. `openGamesModal` opens it in the real TUI. `presentGamesModal` takes an injectable opener and registry, which lets tests drive it. Its `GamesModalHandle` exposes `close`, `restart`, `activeGameId` and `modelThinking`.

### Game definition

`GameDefinition` in `types.ts` is the unit of extension. It carries an `id` (the tab id), a `label`, and the rules, prompts and rendering listed above. `Player` is `"human" | "model"`. `GameState` and `GameMove` are opaque types that each game defines for itself.

### Game registry

`createRegistry(games)` returns an ordered list with a `get(id)` lookup. `DEFAULT_GAMES` is `[ticTacToeGame]`, and `presentGamesModal` falls back to it when no registry is passed.

### Game command

`isGameCommand` returns true when the first whitespace-separated token of a line is `/game`.

### Game model turn

`runGameModelTurn` in `model-turn.ts` sends the game's system prompt and state description through `runModelTurn` from `src/harness/provider/single-turn`, with a 256-token output cap, and passes the reply to `parseMove`. It returns the move, an error string if the turn failed, and an `AgentTurnStats` record (provider, model, latency, token usage, reasoning flag).

### Agent panel

The status and prompt view rendered by `renderAgentPanel`. It shows what the model is being asked, what it last cost and the running session totals, so the operator can see the cost of play.

### Turn statistics

`AgentTurnStats` describes one model turn. `AgentTurnTotals` accumulates them per game session; `emptyTurnTotals` starts an accumulator and `addTurn` adds to it. Counts of local fallbacks and errors are kept alongside the token and time sums. `formatMs` and `formatTokens` turn raw numbers into display strings.

## Main flows

### Opening the games modal

1. `isGameCommand` checks that the input's first token is `/game`.
2. `openGamesModal` (or `presentGamesModal`) takes a registry, which defaults to `createRegistry(DEFAULT_GAMES)`. It calls `openModal` with one tab per game, the `GAMES_FOOTER` hints and the arrow and key handlers.
3. When the tab body mounts, `renderTab` records the body width and height and calls `paint`. `paint` computes the board budget with `resolveGameBudget`, calls the active game's `render`, then calls `renderAgentPanel`.

### Playing a move and the model turn

1. A key from `options.onKeypress` goes to the active game's `onKey`. The key `r` restarts the game instead. If the next state's `turn` is `"model"`, `applyModelMove` starts, guarded by `modelBusy`.
2. `applyModelMove` races `runGameModelTurn` against a timer set to `options.timeoutMs`, defaulting to `GAME_MODEL_TIMEOUT_MS`.
3. On timeout, or when the reply yields no usable move, the modal calls `localMove` and plays that move. If no move results, `pass` hands the turn back, so the game is not left waiting on the model. A reply that carries an error is not replaced by a local move.
4. The notice names the outcome (agent error, timeout, or local move). `addTurn` updates the session totals, `lastTurn` is recorded, and `paint` redraws the panel.

### Tic-tac-toe integration

`src/tui/games/tic-tac-toe` depends on this package in both directions:

- It consumes the shared contracts in `src/tui/games/types.ts` and the presentation helpers.
- It provides `ticTacToeGame`, which `modal.ts` registers in `DEFAULT_GAMES`.

<!-- keryx:reference:begin v=1 hash=2198a792869f7324cdd47d9c52dd79b1fb24b06ca2f1123afc65ab2aa86d07e6 -->
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

- `src/tui` - 5 import(s)
- `src/harness/provider` - 4 import(s)
- `src/tui/games/tic-tac-toe` - 3 import(s)

### Depended on by

- `src/tui/games/tic-tac-toe` - 5 import(s)
- `src/tui` - 1 import(s)

### Dependency basis

- Production imports only: 7 import(s) from test file(s) (e.g. `src/tui/games/modal.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/tui/games/index.ts`

### Graph signals

- Files: 12
- Cross-module imports: 12
<!-- keryx:reference:end -->

## Related Pages

- [Wiki Index](../index.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/tui/games/tic-tac-toe](src-tui-games-tic-tac-toe.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.1 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.

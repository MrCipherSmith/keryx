# Implementation Plan

Status: draft

## Approach

Full feature lives inside `launchTuiAgentShell` in `src/tui/tui-shell.ts`,
reusing existing primitives:

- `showComposerChoice` (`composer-choice.ts`) for the recipient selector.
- `mainTurnAbortController` (already declared at ~line 1538) for force (steer).
- `createBlockRegistry` / `createBlockNavController` (`transcript-blocks.ts`)
  to make each queued item an addressable block with remove/edit/force.

side-1 (`sideQueue`, `spawnSideWorker`) stays as-is; the selector only routes
to either mainQueue or sideQueue.

## Steps

1. T5 (done in analysis): confirm busy-submit insertion point in `runLine`.
2. T6: add recipient selector (main queue | side-1) via `showComposerChoice`
   when `chrome.isBusy()` and the input is a normal (non-control) question.
3. T7: add `mainQueue` state + transcript markers `> qN (p)` and a fleet/
   status counter.
4. T8: implement per-item remove / edit / force on main-queue blocks.
5. T9: drain mainQueue FIFO after the main turn completes.
6. T10: unit tests for selector, queue, edit/remove/force, FIFO.

## Risks

- Interrupting the main turn loses its partial reply (accepted: same as
  `/interrupt` today).
- `[`-rates: the flow dir path contains a digit prefix; guard shell globbing.
- Editing a queued item must preserve its position (re-queue in place).

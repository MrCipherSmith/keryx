# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `reduceState(events)` in `src/harness/monitor/reduce-state.ts` folds a canonical `agent-event` array into an `OrchestratorState` object that validates against the frozen `.metaproject/core/gdskills/contracts/orchestrator-state.schema.json`.
- AC2: State mapping is defined and covered: run_started→run status running, dispatch_created→a plan step (running), dispatch_completed→step done, dispatch_blocked→blocked, validation_failed/run_failed→failed, run_completed→run status completed; a terminal step status is not downgraded.
- AC3: The fold is deterministic — identical event logs yield deep-equal, stable-ordered state (steps in a defined order); no `Date.now`/`Math.random`/network/fs.
- AC4: Replay-safety: folding the whole log equals folding a prefix and then the remaining suffix onto that state (associativity over the event sequence), proven by a test.
- AC5: `reduce-state.test.ts` covers schema validity (via the contracts validator), every status mapping, determinism, and the replay property; the full suite (incl. the zero-`dependencies` guard) passes and `tsc --noEmit` is clean.

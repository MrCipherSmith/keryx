# Implementation Plan

Status: ready to freeze

## Approach

A pure fold, in the same shape as Phase 4's `reduceAgents` but targeting the
`orchestrator-state` schema. The log is authoritative; the state is a projection.

## Steps

1. Read `orchestrator-state.schema.json` to pin the target shape (plan.steps,
   step status, run status, ids).
2. New `src/harness/monitor/reduce-state.ts`:
   - `reduceState(events: AgentEvent[]) → OrchestratorState` — fold run_started →
     status running; dispatch_created → a plan step (status running);
     dispatch_completed → step done; dispatch_blocked → blocked;
     validation_failed/run_failed → failed; run_completed → status completed.
     Deterministic; stable step order (by dispatch/creation order).
   - Result validates against the frozen `orchestrator-state.schema.json`.
3. New `src/harness/monitor/reduce-state.test.ts`: schema-valid output,
   status/step mappings, determinism (same log → deep-equal + stable), and a
   replay property (folding a prefix then the rest equals folding the whole).

## Risks

- Keep the fold PURE (no clock/RNG/fs); ids/timestamps come from the events.
- Output MUST validate against the frozen schema (use the contracts validator in
  the test, as contract.test.ts does).
- Don't overreach into resume wiring — that is a later, incremental adoption step.

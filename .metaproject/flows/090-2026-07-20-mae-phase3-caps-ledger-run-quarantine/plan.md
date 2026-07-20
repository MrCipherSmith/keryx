# Implementation Plan

Status: ready to freeze

## Approach

Add the run-scoped aggregation authority (ledger) and caps as fail-closed guards,
thread the resolved model to the wire through a credential-scoped provider
factory, and quarantine child free-text. `inheritBudget` stays subset-only; the
ledger owns aggregation.

## Steps

1. New `src/harness/child/ledger.ts`: `RemainingBudgetLedger` decremented by every
   granted reservation across `planWaves` and ad-hoc `spawnChild`; a property test
   that aggregate never exceeds parent remaining.
2. Depth/count caps in `spawnChild`: depth from `provenance.taintIds.length <
   maxTreeDepth`; `maxChildren`/`currentChildCount` count cap. Fail-closed.
3. `src/harness/parallel/scheduler.ts`: `ChildTask.modelRequest?` carried through
   (budget fold unchanged).
4. `src/harness/run/run.ts` consumes the child model selection via a
   `childRunModel(extension)` helper feeding `input.provider`/`input.model` ->
   `NormalizedRequest`.
5. `src/harness/provider/make-provider.ts`: accept an injected credential map
   instead of ambient `process.env` for child construction.
6. New `src/harness/child/quarantine.ts`: scan a child summary for
   instruction-shaped patterns; flag with a marker line, never execute or remove.

## Risks

- Ledger must be the single authority for both scheduler and ad-hoc spawns.
- Credential-scoping must keep the interactive-shell Fake fallback while denying
  on the orchestrated child path (denial happens at `resolveChildModel` allowlist).
- Keep all new modules deterministic (injected clock/idSeq; no Date.now/random).

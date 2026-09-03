# Implementation Spec and Plan

Date: 2026-09-03
Agent: flow-orchestrator 1.4.0
Status: confirmed by operator selection of option 2

## What

Introduce one identity-safe foreground-operation lifecycle for the OpenTUI shell and use it for normal agent turns and in-process wiki enrichment. Thread cancellation through wiki scheduling, model turns, provider streams, deep enrichment, persistence, queue handoff, and exit teardown. Preserve explicit wiki-enrich command options.

## Why

The live session `...fa69fce4` could not be interrupted: busy state and cancellation ownership diverged. The fix restores user control, prevents post-cancel writes/UI work, and makes Force semantics deterministic.

## Scope

### In scope

- Foreground operation controller/identity/settlement abstraction.
- TUI registration, interruption, force handoff, queue drain, and exit teardown.
- `AbortSignal` propagation through wiki enrich, `runModelTurn`, provider stream, and deep enrich.
- Abort-aware bounded page scheduling and partial/resume-state correctness.
- Typed parsing or non-lossy handling of explicit `keryx wiki enrich` options.
- Focused tests, full verification, health, bounded review/fix loop, PR and merge.

### Out of scope

- Background-process conversion.
- Background job registry redesign.
- Unrelated TUI or wiki behavior.

## Detailed Steps

1. RED: write deterministic lifecycle/provider/pool/command-routing tests that fail for the reported behavior.
2. Add a reusable foreground-operation owner with operation identity and one settlement/drain path.
3. Register both normal turns and wiki enrichment; make `/interrupt`, Force, and exit cancel the active operation.
4. Thread `signal` through `WikiEnrichInput`, light/deep paths, `ModelTurnInput`, and `ProviderPort.stream`.
5. Make `mapPool` stop scheduling after abort and fence validation, writes, and checkpoint completion.
6. Preserve completed pages and expose an explicit cancellation outcome without misclassifying untouched pages as failures.
7. Preserve explicit command options through a shared parser/typed plan while keeping natural-language picker behavior.
8. REFACTOR: centralize cleanup and remove main-turn-specific duplication without changing queue ordering.
9. Run focused tests, changed tests, type-check/full tests, Code Health, graph refresh, and review-orchestrator.
10. Fix all blocker/major/minor findings within the bounded loop, create PR, wait for required checks, merge into `main`, verify remote state, and complete flow 219.

## Test Strategy

- Provider seam: supplied and already-aborted signals reach `stream` unchanged.
- Pool: abort stops dequeuing; an in-flight provider that ignores abort cannot cause post-abort writes.
- Wiki modes: legacy/light/deep cancellation remains distinct from timeout fallback and preserves completed work.
- TUI lifecycle: interrupt, Force-after-settlement, stale finalizer identity, and exit/no-repaint behavior.
- Routing: natural-language picker remains; explicit CLI flags round-trip without silent replacement.
- Quality: focused Bun suites, `bun run check`, `keryx health run --strict`, and managed review.

## Risks and Mitigations

- Provider ignores signal: fence all post-await side effects and wait for safe settlement.
- Old finalizer clears new busy state: compare operation identity before cleanup.
- Abort loses committed progress: serialize checkpoint updates after successful atomic writes.
- Deep timeout conflated with user cancel: compose signals but preserve distinct reason/result.
- TUI closure is large: extract pure lifecycle logic and test it independently where practical.

## Execution Tracking

- [x] RED tests demonstrate the bug.
- [x] Foreground lifecycle implemented.
- [x] End-to-end cancellation implemented.
- [x] Command semantics preserved.
- [x] Focused and full checks pass (full-suite baseline exception documented).
- [x] Review loop is clean through minor severity.
- [ ] PR merged into recorded `main` and flow completed.

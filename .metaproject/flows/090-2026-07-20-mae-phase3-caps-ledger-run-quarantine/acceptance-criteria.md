# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A run-scoped `RemainingBudgetLedger` decrements across both `planWaves` and ad-hoc `spawnChild`; a property test proves aggregate granted budget never exceeds parent remaining (no per-call full-remaining over-grant). `inheritBudget` stays subset-only and unchanged.
- AC2: `spawnChild` denies fail-closed when `provenance.taintIds.length >= maxTreeDepth` and when the child counter would exceed `maxChildren`, each with a distinct reason; when caps are omitted the pre-Phase-3 behavior is unchanged.
- AC3: `ChildTask` gains an optional `modelRequest` carried through the scheduler; the wave budget fold is unchanged and existing scheduler tests still pass.
- AC4: `run.ts` builds the child `NormalizedRequest.{providerId,modelId}` from the resolved model selection (via a `childRunModel` helper), and `makeProvider` uses an injected credential map (not ambient `process.env`) for child construction; an orchestrated child with an unauthorized/uncredentialed provider is denied (never a silent `FakeProvider` no-op run).
- AC5: Before the orchestrator plans a next dispatch from a child summary, the summary is scanned for instruction-shaped patterns (control-tag imitations, `Human:`/`Assistant:` markers, permission-config mentions); matches are flagged with a prepended marker and never executed or removed.
- AC6: All new modules are deterministic (injected `clock`/`idSeq`; no `Date.now`/`Math.random`); the full test suite (incl. the zero-`dependencies` guard) passes and `tsc --noEmit` is clean.

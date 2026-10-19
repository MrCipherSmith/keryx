---
Title: Module src/harness/completion
Version: 1.0.1
Type: component
Status: accepted
Summary: "`src/harness/completion` groups 3 file(s). Depends on `src/contracts`. Exposes 6 public symbol(s)."
---

# Module src/harness/completion

## Overview

`src/harness/completion` owns completion-gate evaluation for the harness. Its `gate.ts` file exposes `evaluateCompletion`, which takes a `CompletionInput` and `CompletionDeps` and returns a `CompletionGateResult`, an evidence artifact that reports whether a standalone run's completion conditions hold. The result is consumed by Task Manager and never changes managed-flow completion itself.

The companion `metrics.ts` file checks metric reliability with `assessMetricsReliability` and `reduceReliability`. It is a pure helper and is not wired into the pass/fail decision of `evaluateCompletion`.

Callers in `flow`, `child` and `run` use this module so that completion gates are applied consistently, rather than embedding completion logic in execution code.

## How it works

`evaluateCompletion` is a pure function over its input and injected deps. It builds one blocking check per required gate (`gate:<name>`), then adds three more: `evidence:required-present`, `blockers:none-undisposed` and `final-message:emitted`.

The result `status` follows these rules:

- `pass` only when all four conditions hold: every required gate reports `pass`, every required evidence ref is present, no undisposed blocker remains, and a final message was emitted.
- `blocked` when undisposed blockers remain.
- `fail` when no undisposed blockers remain but at least one of the other conditions does not hold.

A final message alone never passes. Determinism comes from the injected deps: `deps.clock` supplies `evaluatedAt`, and `deps.idSeq` supplies `gateId` and is called exactly once per evaluation. The module has no `Date.now`, randomness, network or filesystem access. `schemaVersion` is always 1.

## Key concepts

- `RequiredGate`: a named gate with status `pass`, `fail`, `skipped` or `unknown`. Each one becomes a `gate:<name>` check.
- `CompletionInput`: the run being evaluated, given as `runId`, `requiredGates`, `requiredEvidenceRefs`, `presentEvidenceIds`, `undisposedBlockerIds` and `finalMessageEmitted`.
- `CompletionCheck`: one entry in the result, with `checkId`, `status`, `blocking`, `evidenceRefs` and an optional `detail`. `detail` is left out when empty, because the frozen schema rejects an explicit undefined key.
- `CompletionGateResult`: the evidence artifact, with `schemaVersion`, `gateId`, `runId`, `status`, `checks`, `evaluatedAt`, `evidenceRefs` and `unresolvedBlockerIds`.
- `CompletionDeps`: the injected `clock` and `idSeq` sources.

## Public API

### Interfaces

| Symbol | Description |
|--------|-------------|
| `RequiredGate` | Describes a gate that must be satisfied for completion. It expresses the requirement itself, not necessarily the final evaluation result. |
| `CompletionInput` | Represents the data passed into the completion evaluator — the thing being assessed for completion. |
| `CompletionDeps` | Contains the dependencies needed by completion logic, keeping evaluation separable from environment or service-specific details. |
| `CompletionCheck` | Represents a single check performed during completion evaluation. |
| `CompletionGateResult` | Represents the outcome of completion evaluation, allowing callers to react consistently. |

### Functions

| Symbol | Description |
|--------|-------------|
| `evaluateCompletion` | Runs completion evaluation against the provided input and dependencies. |

## Main flows

1. A caller in `flow`, `child` or `run` builds a `CompletionInput` from its gate states, the required and present evidence refs, the undisposed blockers and whether the final message was emitted.
2. It supplies `CompletionDeps` with a clock and an id sequence.
3. `evaluateCompletion` runs the per-gate, evidence, blocker and final-message checks and returns a `CompletionGateResult`.
4. Task Manager consumes the result as evidence. Managed-flow completion is unchanged.

A second flow covers metric reliability. `assessMetricsReliability` flags any metric that reports `exact` with a `null` value, or reports `estimated` or `unknown` without a `source`. `reduceReliability` returns the worst reliability across a record, so an aggregate is only as trustworthy as its least reliable member.

## Key Files

| File | Purpose |
|------|---------|
| `src/harness/completion/gate.ts` | Core gate implementation and interfaces. Imported by 7 modules. |
| `src/harness/completion/gate.test.ts` | Unit tests for gate behavior and evaluation. |
| `src/harness/completion/metrics.ts` | Pure metric reliability helpers, `assessMetricsReliability` and `reduceReliability`. Not wired into `evaluateCompletion`'s pass/fail decision. |

## Dependencies

- **Depends on:** `src/contracts` (1 import)

## Consumers

The module is consumed by:

- `src/harness/flow` — 4 imports
- `src/harness/child` — 1 import
- `src/harness/run` — 1 import

## Related Pages

- [Wiki Index](../index.md)
- [Module src/contracts](src-contracts.md)
- [Module src/harness/flow](src-harness-flow.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/run](src-harness-run.md)

<!-- keryx:reference:begin v=1 hash=ad860aa341a356038c2784380a1baff049f5477f917e2b2d13e21a9f73a2f2d9 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `RequiredGate`
- `CompletionInput`
- `CompletionDeps`
- `CompletionCheck`
- `CompletionGateResult`
- `evaluateCompletion`

### Key files

- `src/harness/completion/gate.ts` - imported by 7, imports 0
- `src/harness/completion/gate.test.ts` - imported by 0, imports 3
- `src/harness/completion/metrics.ts` - imported by 1, imports 0

### Depended on by

- `src/harness/flow` - 2 import(s)
- `src/harness/run` - 1 import(s)

### Dependency basis

- Production imports only: 4 import(s) from test file(s) (e.g. `src/harness/child/spawn.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 3
- Cross-module imports: 0
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/flow](src-harness-flow.md)
- [Module src/harness/run](src-harness-run.md)

## Changelog

- 1.0.1 - Reference and Related Wiki added from the code graph (the page predated them).
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.

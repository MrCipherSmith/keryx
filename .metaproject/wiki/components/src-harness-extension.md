---
Title: Module src/harness/extension
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/extension` is the harness layer for extension-oriented execution. It groups 8 file(s), exposes 20 public symbol(s), and coordinates extension dispatch, grant evaluation, wave binding, and context-aware retries around lower-level child, mutation, and session primitives."
---

# Module src/harness/extension

## Summary

`src/harness/extension` is the harness that turns extension requests into canonical, grant-bounded child dispatches. It registers extensions fail-closed, decides whether an escalated capability request may proceed, plans extensions into bounded parallel waves, and retries a NEEDS_CONTEXT result with one added artifact. It builds on the child, mutation and parallel primitives beneath it rather than re-implementing their logic.

## Overview

This module owns the extension-facing half of the harness: which extensions may run, what authority a dispatch carries, and how several extension tasks are scheduled. Every gate fails closed. An unregistered extension, an out-of-vocabulary capability, or an escalation missing policy, provenance or approval is denied before any authority is built. The module composes lower-level primitives rather than re-implementing them, and it never writes flow state; the parent owns completion. Its main consumer is `src/commands`.

## How it works

The module is a set of small pure functions. Each takes an input object and a deps object and returns either `{ ok: true, ... }` or `{ ok: false, reason }`. A denial carries only the reason, so no partial authority leaks out. Non-determinism is confined to the injected `idSeq` and `clock` functions.

The code falls into four layers, one per file group:

- **Registry** (`registry.ts`). `registerExtension` is the admission gate. It registers only an extension that has a pinned, non-empty manifest hash and a grant with at least one capability. It keeps no module-level registry and writes nothing.
- **Provenance** (`provenance.ts`). `registerExtensionWithProvenance` wraps the registry and, on success, produces an `ExtensionProvenanceRecord`. The record holds the manifest hash, the grant id, and a fresh copy of the granted capabilities, with a derived-trust provenance linked to a parent. `evaluateRegisteredExtensionCapability` checks one requested capability against that stored record.
- **Execution** (`execute.ts`). `dispatchExtension` builds a canonical `subagent-dispatch` object whose `allowed_actions` is copied from the grant. It also produces the dispatch and result variants of the child contract extension metadata. The returned `parseResult` normalizes a child reply through `parseChildResult`. `evaluateExtensionGrant` is the subset check: a request inside the grant passes, and a broader request (an escalation) needs an explicit `allow` policy, a provenance, and an approval that the injected `checkApproval` accepts. `retryWithContext` handles the NEEDS_CONTEXT case.
- **Waves** (`bound-wave.ts`). `planExtensionWave` checks every task's registration, hands dependency and budget data to `planWaves` for scheduling, and then, for each scheduled task, calls `dispatchExtension` and builds one planned evidence record.

The grant check and the dispatch are separate calls. `dispatchExtension` gates only on registration. If a caller needs a broader capability, it must run `evaluateExtensionGrant` or `evaluateRegisteredExtensionCapability` itself.

## Key concepts

### Registration and grants

An extension is admitted by presenting a pinned manifest and a capability grant. The grant is the ceiling: everything the extension may do must be a subset of the granted `capabilities`. Capabilities come from a closed vocabulary (`read`, `write`, `shell`, `network`, `delegate`), checked by `isKnownCapability` in `src/harness/child/isolation`. An unknown capability fails closed before any subset reasoning.

**Key public shapes:**

- `RegisterExtensionInput` and `RegisterExtensionResult`
- `CapabilityGrant` and `ExtensionManifest`
- `ExtensionProvenanceRecord` — the stored form of a registered extension

### Extension dispatch

Dispatch turns an admitted extension and a task into a canonical child request. `dispatchExtension` copies the grant's capabilities into `allowed_actions`, sets the output contract's artifact path from the result artifact, and sets the runtime budget from the reserved budget. It returns the dispatch, the extension metadata, and a `parseResult` closure bound to the same `dispatch_id`.

**Key public shapes:**

- `DispatchExtensionInput`, `DispatchExtensionDeps`, `DispatchExtensionResult`
- `CanonicalDispatch` — the normalized request, with `dispatch_id` and `allowed_actions` typed for direct access
- `DispatchArtifactRef` — `artifactId`, `kind`, `path` and `hash` for a durable artifact

### Grant evaluation

`evaluateExtensionGrant` decides whether a requested capability set may proceed. A subset request passes. An escalation is denied unless the policy is `allow`, a provenance is present, and `checkApproval` returns a valid result. A `deny` or `ask` policy never grants an escalation, and each missing piece produces its own denial reason.

**Key public shapes:**

- `EvaluateExtensionGrantInput`, `EvaluateExtensionGrantDeps`, `EvaluateExtensionGrantResult`

### Extension waves

A wave is a group of extension tasks that the scheduler runs concurrently under an aggregate budget. `ExtensionWaveTask` carries one task's dependencies, registration, grant, budget request and dispatch fields. `planExtensionWave` returns `BoundWave` values, each with index-aligned `taskIds`, `dispatches` and `attemptEvidence`. Planning schedules and binds the work; it does not run it.

**Key public shapes:**

- `ExtensionWaveTask`, `PlanExtensionWaveInput`, `PlanExtensionWaveDeps`, `PlanExtensionWaveResult`
- `BoundWave`

### Artifact references

`DispatchArtifactRef` names the durable artifacts a dispatch writes to, and it is embedded in both the dispatch and its extension metadata. `ArtifactRefLike` (`path`, `kind`, `exists`) is the lighter shape used for bounded context in retries.

### Context-aware retries

`retryWithContext` handles a NEEDS_CONTEXT child result that names one missing artifact. It produces a retry that keeps the same `dispatchId` and a context list made of the prior references plus the missing one. The prior attempt is never modified.

**Key public shapes:**

- `RetryWithContextInput`, `RetryWithContextDeps`, `RetryWithContextResult`

## Main flows

### 1. Registering and dispatching an extension

```
registerExtension(input) | registerExtensionWithProvenance(input, deps)
    │  ok:false → denied, nothing built
    ▼
dispatchExtension(input, deps)
    ├─► allowed_actions = grant.capabilities (copied)
    ├─► output_contract, budget and provenance filled from the input
    └─► { dispatch, extension, parseResult }
             │
             ▼
   caller runs the child, then parseResult(rawReply) → canonical subagent-result
```

Steps:

1. The caller registers the extension. Registration fails closed without a pinned manifest or a non-empty grant.
2. The caller passes the registration result, the grant and the reserved budget to `dispatchExtension`. A failed registration returns `{ ok: false, reason }` and no dispatch is built.
3. The child runs outside this module. Its reply goes through `parseResult`, which normalizes a STATUS-first reply into the canonical object.

The grant check is not part of this path. A caller that needs a broader capability calls `evaluateExtensionGrant` or `evaluateRegisteredExtensionCapability` first.

### 2. Planning and binding an extension wave

1. The caller passes `PlanExtensionWaveInput`, with its tasks and a `PlanWavesConfig`. If any task is unregistered, the whole plan is denied before scheduling.
2. `planWaves` from `src/harness/parallel/scheduler` assigns tasks to waves, folds their budgets, and rejects cycles, cancellations and degenerate concurrency. Its denial is passed through unchanged.
3. For each scheduled task, `dispatchExtension` builds a grant-bounded dispatch, and a fresh planned `EvidenceRecord` is created for that attempt. The artifact kind is `extension-dispatch-planned` with derived trust, so a planned attempt is never recorded as a completed one.
4. The result is one `BoundWave` per wave, in the order `planWaves` returns them.

### 3. Retrying extension work with context

1. The caller passes a `RetryWithContextInput` with the prior attempt, the one missing artifact reference, and the dispatch id.
2. The retry is refused unless the prior result is `NEEDS_CONTEXT` and the dispatch id matches the prior attempt.
3. On success the caller receives a `retryDispatch` with the same dispatch id and a new context array, plus `addedContext` naming the one artifact path. The prior attempt is left unchanged.

---

<!-- keryx:reference:begin v=1 hash=237dd4978ca000c0ef8ce691f1aaf995cc6991ce86b44837193a8fec2da9c456 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `DispatchArtifactRef`
- `DispatchExtensionInput`
- `DispatchExtensionDeps`
- `CanonicalDispatch`
- `DispatchExtensionResult`
- `dispatchExtension`
- `EvaluateExtensionGrantInput`
- `EvaluateExtensionGrantDeps`
- `EvaluateExtensionGrantResult`
- `evaluateExtensionGrant`
- `ArtifactRefLike`
- `RetryWithContextInput`
- `RetryWithContextDeps`
- `RetryWithContextResult`
- `retryWithContext`
- `ExtensionWaveTask`
- `PlanExtensionWaveInput`
- `PlanExtensionWaveDeps`
- `BoundWave`
- `PlanExtensionWaveResult`

### Key files

- `src/harness/extension/execute.ts` - imported by 5, imports 5
- `src/harness/extension/bound-wave.ts` - imported by 2, imports 7
- `src/harness/extension/registry.ts` - imported by 8, imports 0
- `src/harness/extension/bound-wave.test.ts` - imported by 0, imports 6
- `src/harness/extension/provenance.ts` - imported by 1, imports 5
- `src/harness/extension/execute.test.ts` - imported by 0, imports 5

### Depends on

- `src/harness/child` - 5 import(s)
- `src/harness/mutation` - 3 import(s)
- `src/harness/session` - 2 import(s)
- `src/harness/evidence` - 1 import(s)
- `src/harness/parallel` - 1 import(s)

### Depended on by

- `src/commands` - 3 import(s)

### Dependency basis

- Production imports only: 8 import(s) from test file(s) (e.g. `src/harness/extension/bound-wave.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 8
- Cross-module imports: 12
<!-- keryx:reference:end -->

## Related pages

- [Wiki Index](../index.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/harness/evidence](src-harness-evidence.md)
- [Module src/harness/parallel](src-harness-parallel.md)
- [Module src/contracts](src-contracts.md)
- [Module src/commands](src-commands.md)

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/harness/evidence](src-harness-evidence.md)
- [Module src/harness/parallel](src-harness-parallel.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched for the gdwiki workflow.

---
Title: Module src/harness/extension
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/extension` groups 8 file(s). Depends on `src/harness/child`, `src/harness/mutation`, `src/harness/session`. Exposes 20 public symbol(s)."
---
# Module src/harness/extension

## Summary

`src/harness/extension` is the harness layer for extension-oriented execution. It groups eight source files, exposes twenty public symbols, and coordinates extension dispatch, grant evaluation, wave binding, and context-aware retries around lower-level child, mutation, and session primitives.

## Overview

This module owns the extension-facing portion of the harness. It turns higher-level command requests into structured extension operations, evaluates whether those operations are allowed, and coordinates execution using existing harness capabilities.

The module sits between consumer-facing code, primarily `src/commands`, and lower-level execution primitives. Its dependencies indicate that it works with child processes, mutation effects, and session state, while also relying on evidence, parallel helpers, and shared contracts to represent and execute extension work.

## How it works

The module is organized around a small public contract:

- Inputs describe the operation that should be performed.
- Dependencies provide lower-level capabilities.
- Results describe the outcome of dispatch, evaluation, retry, or planning.

The public API is grouped around three main concerns:

- **Extension dispatch** — `dispatchExtension` and related types describe how extension work is requested and executed.
- **Grant evaluation** — `evaluateExtensionGrant` and related types decide whether an extension operation may proceed.
- **Wave planning and binding** — `planExtensionWave`, `ExtensionWaveTask`, and `BoundWave` describe grouped extension work and bind it for execution.
- **Retry with context** — `retryWithContext` provides context-aware retry behavior for extension operations.

Several files support these concerns directly:

- `src/harness/extension/execute.ts` appears to be the central execution file for extension dispatch.
- `src/harness/extension/bound-wave.ts` represents bound extension waves and their relationships.
- `src/harness/extension/registry.ts` is imported widely and likely provides extension discovery or lookup metadata.
- `src/harness/extension/provenance.ts` supports artifact origin and provenance tracking.

The module’s dependencies suggest a clear separation of responsibilities: `src/harness/child`, `src/harness/mutation`, and `src/harness/session` provide execution effects, while `src/harness/evidence` and `src/harness/parallel` support evidence handling and concurrent execution.

## Key concepts

### Extension dispatch

Extension dispatch is the process of requesting and executing an extension operation.

Key public shapes:

- `DispatchExtensionInput`
- `DispatchExtensionDeps`
- `DispatchExtensionResult`
- `CanonicalDispatch`
- `DispatchArtifactRef`

Together, these describe a normalized extension request, the dependencies required to execute it, and the result returned to the caller.

### Extension grant

An extension grant describes whether an extension operation is allowed to proceed.

Key public shapes:

- `EvaluateExtensionGrantInput`
- `EvaluateExtensionGrantDeps`
- `EvaluateExtensionGrantResult`

The grant-evaluation API gives callers a way to check authorization or eligibility before executing an extension operation.

### Extension waves

Extension work may be represented as waves: grouped extension tasks that can be planned, bound, and executed together.

Key public shapes:

- `ExtensionWaveTask`
- `PlanExtensionWaveInput`
- `PlanExtensionWaveDeps`
- `PlanExtensionWaveResult`
- `BoundWave`

A wave represents a collection of related extension tasks. A bound wave appears to represent tasks that have been associated with concrete execution context.

### Artifact references

Several interfaces refer to artifacts used by extension dispatch:

- `DispatchArtifactRef`
- `ArtifactRefLike`

These describe artifact references used by the extension execution layer.

### Context-aware retries

`retryWithContext` allows extension operations to be retried while preserving execution context.

Key public shapes:

- `RetryWithContextInput`
- `RetryWithContextDeps`
- `RetryWithContextResult`

## Main flows

### 1. Dispatching an extension operation

At a high level, an extension dispatch flow likely follows this pattern:

1. A caller, typically from `src/commands`, calls `dispatchExtension`.
2. The caller provides a `DispatchExtensionInput` and `DispatchExtensionDeps`.
3. The dispatch layer normalizes the request into a canonical dispatch shape.
4. Grant evaluation determines whether the operation is allowed.
5. The operation is executed using lower-level harness primitives from child, mutation, and session.
6. Results are returned to the caller.

The implementation may also coordinate waves, artifact references, retries, and evidence during this flow.

### 2. Planning and binding extension waves

When extension work needs to be grouped or scheduled, the module can plan a wave:

1. A caller provides a `PlanExtensionWaveInput` and dependencies.
2. The planner produces a `PlanExtensionWaveResult`.
3. Extension tasks are represented through `ExtensionWaveTask`.
4. Tasks may be bound into executable structures through `BoundWave`.

This flow supports organizing multiple extension operations as a coordinated unit of work.

### 3. Retrying extension work with context

When extension execution requires retry behavior:

1. A caller invokes `retryWithContext`.
2. It supplies a `RetryWithContextInput` and `RetryWithContextDeps`.
3. The helper runs the operation while preserving the retry context.
4. The caller receives a `RetryWithContextResult`.

This supports robust extension execution when operations need to be retried without losing surrounding execution context.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `DispatchArtifactRef` (interface)
- `DispatchExtensionInput` (interface)
- `DispatchExtensionDeps` (interface)
- `CanonicalDispatch` (interface)
- `DispatchExtensionResult`
- `dispatchExtension` (function)
- `EvaluateExtensionGrantInput` (interface)
- `EvaluateExtensionGrantDeps` (interface)
- `EvaluateExtensionGrantResult`
- `evaluateExtensionGrant` (function)
- `ArtifactRefLike` (interface)
- `RetryWithContextInput` (interface)
- `RetryWithContextDeps`
- `RetryWithContextResult`
- `retryWithContext` (function)
- `ExtensionWaveTask` (interface)
- `PlanExtensionWaveInput` (interface)
- `PlanExtensionWaveDeps` (interface)
- `BoundWave` (interface)
- `PlanExtensionWaveResult`

### Key files

- `src/harness/extension/execute.ts` - imported by 5, imports 5
- `src/harness/extension/bound-wave.ts` - imported by 2, imports 7
- `src/harness/extension/registry.ts` - imported by 8, imports 0
- `src/harness/extension/bound-wave.test.ts` - imported by 0, imports 6
- `src/harness/extension/provenance.ts` - imported by 1, imports 5
- `src/harness/extension/execute.test.ts` - imported by 0, imports 5

### Depends on

- `src/harness/child` - 7 import(s)
- `src/harness/mutation` - 5 import(s)
- `src/harness/session` - 3 import(s)
- `src/harness/evidence` - 2 import(s)
- `src/harness/parallel` - 2 import(s)
- `src/contracts` - 1 import(s)

### Depended on by

- `src/commands` - 3 import(s)

### Graph signals

- Files: 8
- Cross-module imports: 20

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/harness/evidence](src-harness-evidence.md)
- [Module src/harness/parallel](src-harness-parallel.md)
- [Module src/contracts](src-contracts.md)
- [Module src/commands](src-commands.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.

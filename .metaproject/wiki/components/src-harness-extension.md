---
Title: Module src/harness/extension
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/extension` is the harness layer for extension-oriented execution. It groups 8 file(s), exposes 20 public symbol(s), and coordinates extension dispatch, grant evaluation, wave binding, and context-aware retries around lower-level child, mutation, and session primitives."
---

# Module src/harness/extension

## Summary

`src/harness/extension` is the harness layer for extension-oriented execution. It groups eight source files, exposes twenty public symbols, and coordinates extension dispatch, grant evaluation, wave binding, and context-aware retries around lower-level child, mutation, and session primitives.

## Overview

This module owns the extension-facing portion of the harness. It transforms higher-level command requests into structured extension operations, evaluates whether those operations are permitted, and coordinates execution using existing harness capabilities.

The module sits between consumer-facing code (primarily `src/commands`) and lower-level execution primitives. Its dependencies indicate that it works with child processes, mutation effects, and session state, while also relying on evidence, parallel helpers, and shared contracts to represent and execute extension work.

## How it works

The module is organized around a small public contract:

- **Inputs** describe the operation to perform
- **Dependencies** provide lower-level capabilities
- **Results** describe the outcome of dispatch, evaluation, retry, or planning

The public API is grouped around four main concerns:

- **Extension dispatch** — `dispatchExtension` and related types describe how extension work is requested and executed
- **Grant evaluation** — `evaluateExtensionGrant` and related types decide whether an extension operation may proceed
- **Wave planning and binding** — `planExtensionWave`, `ExtensionWaveTask`, and `BoundWave` describe grouped extension work and bind it for execution
- **Retry with context** — `retryWithContext` provides context-aware retry behavior for extension operations

### Key files

| File | Purpose | Import/Export Ratio |
|------|---------|---------------------|
| `execute.ts` | Central execution for extension dispatch | 5 imports, 5 exports |
| `bound-wave.ts` | Bound extension waves and their relationships | 2 importers, 7 imports |
| `registry.ts` | Extension discovery and lookup metadata | 8 importers |
| `provenance.ts` | Artifact origin and provenance tracking | 1 importer, 5 imports |

### Dependency responsibilities

| Dependency | Role |
|------------|------|
| `src/harness/child` | Child process execution effects (7 imports) |
| `src/harness/mutation` | Mutation effects (5 imports) |
| `src/harness/session` | Session state management (3 imports) |
| `src/harness/evidence` | Evidence handling (2 imports) |
| `src/harness/parallel` | Concurrent execution support (2 imports) |
| `src/contracts` | Shared type contracts (1 import) |

## Key concepts

### Extension dispatch

Extension dispatch is the process of requesting and executing an extension operation. The dispatch layer normalizes requests into a canonical shape and coordinates execution through lower-level primitives.

**Key public shapes:**

- `DispatchExtensionInput` — describes the operation to dispatch
- `DispatchExtensionDeps` — dependencies required for execution
- `DispatchExtensionResult` — outcome returned to the caller
- `CanonicalDispatch` — normalized extension request
- `DispatchArtifactRef` — reference to artifacts used during dispatch

### Extension grant

An extension grant determines whether an extension operation is allowed to proceed. This evaluation happens before execution and provides a way to check authorization or eligibility.

**Key public shapes:**

- `EvaluateExtensionGrantInput` — the grant request
- `EvaluateExtensionGrantDeps` — dependencies for grant evaluation
- `EvaluateExtensionGrantResult` — whether the operation is permitted

### Extension waves

Extension work may be organized as waves: grouped extension tasks that can be planned, bound, and executed together as a coordinated unit.

**Key public shapes:**

- `ExtensionWaveTask` — represents a single task within a wave
- `PlanExtensionWaveInput` — input for wave planning
- `PlanExtensionWaveDeps` — dependencies for wave planning
- `PlanExtensionWaveResult` — produced wave plan
- `BoundWave` — tasks associated with concrete execution context

### Artifact references

Several interfaces describe artifact references used by the extension execution layer:

- `DispatchArtifactRef` — artifact reference in dispatch context
- `ArtifactRefLike` — generic artifact reference shape

### Context-aware retries

`retryWithContext` enables extension operations to be retried while preserving execution context, supporting robust extension execution when operations may need to be retried.

**Key public shapes:**

- `RetryWithContextInput` — retry configuration and operation
- `RetryWithContextDeps` — dependencies for retry logic
- `RetryWithContextResult` — outcome including retry state

## Main flows

### 1. Dispatching an extension operation

```
Caller (src/commands)
    │
    ▼
dispatchExtension(input, deps)
    │
    ├─► Normalize to CanonicalDispatch
    │
    ├─► evaluateExtensionGrant() → check authorization
    │
    ├─► Execute via child/mutation/session primitives
    │
    └─► Return DispatchExtensionResult
```

Steps:

1. A caller, typically from `src/commands`, invokes `dispatchExtension`
2. The caller provides a `DispatchExtensionInput` and `DispatchExtensionDeps`
3. The dispatch layer normalizes the request into a canonical dispatch shape
4. Grant evaluation determines whether the operation is allowed
5. The operation executes using lower-level harness primitives
6. Results are returned to the caller

The implementation may also coordinate waves, artifact references, retries, and evidence during this flow.

### 2. Planning and binding extension waves

When extension work needs to be grouped or scheduled:

1. A caller provides a `PlanExtensionWaveInput` and dependencies
2. The planner produces a `PlanExtensionWaveResult`
3. Extension tasks are represented through `ExtensionWaveTask`
4. Tasks are bound into executable structures through `BoundWave`

This flow supports organizing multiple extension operations as a coordinated unit of work.

### 3. Retrying extension work with context

When extension execution requires retry behavior:

1. A caller invokes `retryWithContext`
2. It supplies a `RetryWithContextInput` and `RetryWithContextDeps`
3. The helper runs the operation while preserving the retry context
4. The caller receives a `RetryWithContextResult`

This supports robust extension execution when operations need to be retried without losing surrounding execution context.

---

## Reference

> Extracted deterministically by `keryx wiki collect`; regenerated by `--force`. The prose sections above are the agent/human-owned part.

### Public API

| Symbol | Type |
|--------|------|
| `DispatchArtifactRef` | interface |
| `DispatchExtensionInput` | interface |
| `DispatchExtensionDeps` | interface |
| `CanonicalDispatch` | interface |
| `DispatchExtensionResult` | type/function |
| `dispatchExtension` | function |
| `EvaluateExtensionGrantInput` | interface |
| `EvaluateExtensionGrantDeps` | interface |
| `EvaluateExtensionGrantResult` | type/function |
| `evaluateExtensionGrant` | function |
| `ArtifactRefLike` | interface |
| `RetryWithContextInput` | interface |
| `RetryWithContextDeps` | interface |
| `RetryWithContextResult` | type/function |
| `retryWithContext` | function |
| `ExtensionWaveTask` | interface |
| `PlanExtensionWaveInput` | interface |
| `PlanExtensionWaveDeps` | interface |
| `BoundWave` | interface |
| `PlanExtensionWaveResult` | type/function |

### Key files

| File | Importers | Imports |
|------|-----------|---------|
| `src/harness/extension/execute.ts` | 5 | 5 |
| `src/harness/extension/bound-wave.ts` | 2 | 7 |
| `src/harness/extension/registry.ts` | 8 | 0 |
| `src/harness/extension/bound-wave.test.ts` | 0 | 6 |
| `src/harness/extension/provenance.ts` | 1 | 5 |
| `src/harness/extension/execute.test.ts` | 0 | 5 |

### Module graph

```
src/harness/extension
    ├── src/harness/child (7 imports)
    ├── src/harness/mutation (5 imports)
    ├── src/harness/session (3 imports)
    ├── src/harness/evidence (2 imports)
    ├── src/harness/parallel (2 imports)
    └── src/contracts (1 import)

src/commands ──► src/harness/extension (3 imports)
```

### Graph signals

- Files: 8
- Cross-module imports: 20

## Related pages

- [Wiki Index](../index.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/harness/evidence](src-harness-evidence.md)
- [Module src/harness/parallel](src-harness-parallel.md)
- [Module src/contracts](src-contracts.md)
- [Module src/commands](src-commands.md)

## Changelog

- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched for the gdwiki workflow.

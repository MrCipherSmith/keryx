---
Title: Module src/harness/completion
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/completion` groups 3 file(s). Depends on `src/contracts`. Exposes 6 public symbol(s)."
---

# Module src/harness/completion

## Overview

`src/harness/completion` owns the completion-evaluation part of the harness. It provides a small, explicit contract for deciding whether a completion condition has been satisfied, separating the data needed for evaluation from the dependencies used to perform it.

The module is used by higher-level harness components such as `flow`, `child`, and `run`. Those callers rely on it to apply completion gates consistently rather than embedding completion logic directly in execution code.

## Architecture

The module is organized around a **completion gate abstraction**:

1. A caller provides `CompletionInput` — describing what is being evaluated.
2. The caller also provides `CompletionDeps` — containing the dependencies needed to make a completion decision.
3. `evaluateCompletion` performs the evaluation and returns a `CompletionGateResult`.
4. The result tells callers whether completion was established under the given conditions.

The dependency on `src/contracts` means the module reuses shared definitions rather than defining completion-related domain types independently.

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

## Usage Flow

1. A caller from `flow`, `child`, or `run` constructs a `CompletionInput`.
2. It supplies any required `CompletionDeps`.
3. It calls `evaluateCompletion`.
4. The module returns a `CompletionGateResult` for the caller to consume.

## Key Files

| File | Purpose |
|------|---------|
| `src/harness/completion/gate.ts` | Core gate implementation and interfaces. Imported by 7 modules. |
| `src/harness/completion/gate.test.ts` | Unit tests for gate behavior and evaluation. |
| `src/harness/completion/metrics.ts` | Supporting metrics-related functionality. |

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

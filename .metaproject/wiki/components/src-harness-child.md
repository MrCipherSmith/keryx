---
Title: Module src/harness/child
Version: 0.1.3
Type: component
Status: accepted
VerifiedAt: 1675e43360b9d786d2916a9518ebe46bb3b7747c
VerifiedScope: sha256:531a97b381d9f85f78380c19209a7ca3293f4bfb7013a88c77a03e74bef2ab3e
Summary: "Child subagent harness: budget and policy inheritance, provenance, dispatch extension, and result canonicalization."
---
```markdown
---
Title: Module src/harness/child
Version: 0.1.1
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:6b80b90c52dd6cfe6f9f89a5cef07ad0b1b53d84df8db1f82cb8d508a3f82185
Summary: "Child subagent harness: budget and policy inheritance, provenance, dispatch extension, and result canonicalization."
---
# Module src/harness/child

## Overview

`src/harness/child` provides the primitives for spawning and orchestrating child subagents within the harness system. A "child" in this context is a subagent or task executed under the umbrella of a parent execution—typically with inherited constraints, budget reservations, and policy guardrails.

This module answers several questions that arise whenever a parent harness needs to delegate work:

- **What budget does the child have?** — Derived from the parent's remaining budget via `inheritBudget`.
- **What policy applies?** — Carried over from the parent via `inheritPolicy`, with `isKnownCapability` validating each capability claim.
- **Where did the child come from?** — Recorded as provenance metadata via `childProvenance`.
- **How is the child integrated into the dispatch flow?** — Built into a `ChildContractExtension` via `buildChildDispatchExtension`.
- **What does the child's result look like?** — Normalized into a `CanonicalSubagentResult` by `parseChildResult`.

The module is a component of `src/harness`. It is used by `src/harness/extension`, `src/harness/parallel`, `src/harness/process`, and `src/harness/tool/builtin`, and is benchmarked by `scripts/benchmark`.

## How it works

The module has three cooperating layers:

### Contract types

`contract.ts` defines the public interfaces that both the parent harness and child execution agree on:

- `ChildContractExtension` — describes how a child run attaches to the harness dispatch pipeline
- `CanonicalSubagentResult` — the normalized outcome shape expected by consumers
- `SpawnSubagentRequest` / `SpawnSubagentResult` — the request/response pair for spawning a subagent
- `SubagentConfig` — configuration passed to a spawned subagent
- `SubagentContext` — runtime context available to the subagent

### Inheritance helpers

These functions carry context from the parent to the child:

- `inheritBudget(requestedReservation, parentRemainingBudget)` → `InheritBudgetResult` — derives the budget available to a child, given what the parent has left and what the child wants to reserve. The result includes a `BudgetReservation` and a `ParentRemainingBudget` reflecting the remainder.
- `inheritPolicy(requestedCapabilities)` → `InheritPolicyResult` — carries policy constraints to the child. `isKnownCapability` guards this by checking whether a given capability is recognized by the policy system.
- `allowedProvidersFromDetected` — determines which providers are permissible given detected capabilities.

### Lifecycle orchestration

These files manage the child's execution and tracking:

- `isolation.ts` — sets up the child's execution environment (imported by 16 other files, the most of any file in the module)
- `spawn.ts` — handles the actual spawning of a subagent process or context
- `orchestrate.ts` — coordinates the child's run, tracks progress, and manages timeouts
- `ledger.ts` — records the child's execution ledger for auditability

`buildChildDispatchExtension` is the main integration point: given inheritance inputs, it produces a `ChildContractExtension` that later consumers (extensions, parallel runners, process runners) can attach to a child run.

## Key concepts

### Budget reservation

When a parent spawns a child, it must decide how much of its own remaining budget to allocate. `BudgetReservation` represents the child's allocation; `ParentRemainingBudget` represents what stays with the parent afterward. `InheritBudgetResult` bundles both values after the inheritance decision.

### Budget/policy inheritance

`inheritBudget` and `inheritPolicy` are the primary entry points for constraint propagation. `isKnownCapability` validates capability requests during policy inheritance, ensuring only recognized capabilities are passed through.

### Provenance

`ChildProvenanceDeps` and `childProvenance` capture lineage: which parent produced this child, under what constraints, and with what results. This enables traceability back through the execution tree.

### Dispatch extension

`ChildContractExtension` describes how a child run plugs into the harness dispatch flow. `BuildChildDispatchExtensionInput` provides the inputs needed to construct one. `buildChildDispatchExtension` performs the construction.

### Canonical child results

Child executions may produce output in varying formats. `CanonicalSubagentResult` and `CanonicalSubagentStatus` provide a normalized shape. `parseChildResult` converts raw child output into a `ParsedChildResult`, while `serializeChildResult` goes the opposite direction. `ParseChildResultMeta` carries metadata about the parse.

## Main flows

### 1. Budget and policy inheritance

The caller invokes `inheritBudget` with the child's requested reservation and the parent's remaining budget, then `inheritPolicy` with the child's requested capabilities. The resulting `InheritBudgetResult` and `InheritPolicyResult` constrain the child's run.

### 2. Child dispatch

The caller assembles a `BuildChildDispatchExtensionInput`, calls `buildChildDispatchExtension`, and uses the returned `ChildContractExtension` to integrate the child into the harness dispatch pipeline.

### 3. Result canonicalization

When the child finishes, `parseChildResult` normalizes its output into a `ParsedChildResult` / `CanonicalSubagentResult`, `childProvenance` attaches lineage, and `serializeChildResult` produces the serialized form used downstream.

---

<!-- keryx:reference:begin v=1 hash=d731a8112af659e38f10d638bdf1d949e6da8b66c3b8ce5f1b603d7d06bfc1de -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `GitWorktreePortOptions` (interface)
- `createGitWorktreePort` (function)
- `BudgetReservation` (interface)
- `ParentRemainingBudget` (interface)
- `InheritBudgetResult`
- `inheritBudget` (function)
- `InheritPolicyResult`
- `isKnownCapability` (function)
- `inheritPolicy` (function)
- `ChildProvenanceDeps` (interface)
- `childProvenance` (function)

### Key files

- `src/harness/child/git-worktree-port.ts` - imported by 17, imports 1
- `src/harness/child/isolation.ts` - imported by 15, imports 3
- `src/harness/child/worktree.ts` - imported by 14, imports 1
- `src/harness/child/orchestrate.ts` - imported by 5, imports 7
- `src/harness/child/spawn.ts` - imported by 5, imports 7
- `src/harness/child/contract.ts` - imported by 11, imports 0

### Depends on

- `src/harness/policy` - 7 import(s)
- `src/harness/session` - 4 import(s)
- `src/commands` - 1 import(s)
- `src/harness/hooks` - 1 import(s)
- `src/harness/evidence` - 1 import(s)

### Depended on by

- `scripts/benchmark` - 11 import(s)
- `src/harness/extension` - 5 import(s)
- `src/commands` - 4 import(s)
- `src/harness/external` - 4 import(s)
- `src/harness/tool/builtin` - 3 import(s)
- `src/bus` - 2 import(s)

### Dependency basis

- Production imports only: 37 import(s) from test file(s) (e.g. `src/commands/agents-external-antigravity.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 25
- Cross-module imports: 14
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/commands](src-commands.md)
- [Module scripts/benchmark](scripts-benchmark.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 0.1.3 - Reference refreshed from the code graph (1675e433).
- 0.1.2 - Reference refreshed from the code graph (4e80355f).
- 0.1.1 - Reference refreshed from the code graph (5886c474).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-08-13T11:45:47.763Z. Prose sections are drafts for the gdwiki enrich workflow.
- 0.1.0 - Prose enriched and accepted for the `src/harness/child` module wiki page.
```

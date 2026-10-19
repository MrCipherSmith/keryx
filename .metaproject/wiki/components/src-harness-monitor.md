---
Title: Module src/harness/monitor
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/monitor` groups 4 file(s). Depends on `src/contracts`. Exposes 8 public symbol(s)."
---

# Module src/harness/monitor

## Summary

`src/harness/monitor` is the pure accounting layer for subagent monitoring. It folds a canonical `agent-event` stream into per-dispatch snapshots, derives deltas between snapshots, and folds the same stream into an orchestrator state.

## Overview

`src/harness/monitor` owns the deterministic bookkeeping of subagent dispatches: what each dispatch is doing, what it has consumed, and how that changed between two observations. Its public surface defines the data shapes (`AgentEvent`, `AgentStatus`, `AgentUsage`, `AgentRecord`, `AgentsSnapshot`, `AgentDelta`) and two helpers, `reduceAgents` and `diffAgents`.

The module is deliberately split in two layers. Per the file header in `src/harness/monitor/reduce.ts`, this code reads no clock, random source, network or filesystem; all I/O and arrival-ordered rendering belong to the CLI display layer (`keryx agents monitor`). Identical inputs therefore produce deep-equal, stably ordered output, so a snapshot can be replayed and hashed. The module is consumed by [src/commands](src-commands.md) and [src/harness/external](src-harness-external.md), and it depends on [src/contracts](src-contracts.md) so its shapes stay aligned with shared project contracts.

## How it works

The module is two small pure folds plus shared shapes.

- `reduce.ts` holds the per-agent accounting. `reduceAgents` walks an event array in order, keys every record by `dispatch_id`, and maps event types onto an `AgentStatus`. Events without a `dispatch_id` are run-level and create no record. Model, source and budget are copied from each event's `data` when present, and usage is accumulated under a strict rule: only samples marked `exact: true` add tokens, while any inexact sample clears the record's `usage.exact` flag. Terminal statuses (`done`, `blocked`, `failed`) are never overwritten by a later event, which keeps the fold order-tolerant at the end of a dispatch.
- `diffAgents` compares two snapshots by `dispatchId`. It produces a delta for each dispatch that is new (`spawned`), a status change, or missing from the newer snapshot (`idle`), and sorts the result.
- `reduce-state.ts` reuses the `AgentEvent` shape to fold the same stream into an `OrchestratorState` (run status, plan steps, artifacts). It is built as `initialOrchestratorState(meta)` plus a pure left fold, `applyEvents`, which clones its input and never mutates it. Because each event is applied independently, applying a prefix and then a suffix equals applying the whole sequence, so replay is safe. `reduceState` is the one-call wrapper.

The two files share the same discipline: deterministic output, stable sorting, and guards that stop terminal states from regressing.

## Key concepts

- **AgentEvent**: one canonical event from the `agent-event` stream, carrying `run_id`, `event_id`, an optional `dispatch_id`, a `type` drawn from a fixed union (for example `dispatch_created`, `dispatch_completed`, `validation_failed`, `artifact_written`), optional `data`, and `timestamp_utc`.
- **AgentStatus**: the folded state of one dispatch: `running`, `done`, `blocked`, `failed` or `unknown`. `unknown` is the state before any status-bearing event has arrived.
- **AgentUsage**: input and output token totals plus an `exact` flag. The totals count only provider-reported exact samples; the flag tells a reader whether every sample was exact.
- **AgentRecord**: the folded record for one dispatch (`dispatchId`, `status`, optional `model`, `source`, `budgetRemaining`, and `usage`).
- **AgentsSnapshot**: a point-in-time view, a `runId` (taken from the first event) and the records sorted by `dispatchId`.
- **AgentDelta**: one observed change between snapshots, with a `kind` of `spawned`, `running`, `idle`, `done`, `failed` or `blocked`.
- **OrchestratorState, OrchestratorStep, RunStatus, StepStatus**: the run-level view defined in `reduce-state.ts`. A step is keyed by dispatch, and `current_step` tracks the most recently created dispatch. The state's `updated_at` only moves forward.

## Main flows

### Snapshot reduction

1. A caller passes a chronologically ordered `AgentEvent` array to `reduceAgents`.
2. Each event with a `dispatch_id` either creates or updates that dispatch's record. `dispatch_created` sets `running`, `dispatch_completed` sets `done`, `dispatch_blocked` sets `blocked`, and `validation_failed` or `run_failed` set `failed`.
3. Model, source and budget are read from `data`, and `data.usage` is summed only when it is marked exact.
4. The function returns an `AgentsSnapshot` with records sorted by `dispatchId`.

### Change detection

1. A caller holds two snapshots, a previous and a current one, and calls `diffAgents(prev, next)`.
2. A dispatch present only in `next` yields `spawned`. A dispatch present only in `prev` yields `idle`, meaning it stopped reporting. A dispatch present in both yields its new status when that status changed and is not `unknown`.
3. The caller receives the `AgentDelta` list, sorted by `dispatchId`.

### Orchestrator state fold

1. `reduceState(events, meta)` starts from `initialOrchestratorState(meta)` (status `pending`, empty plan) and applies the events through `applyEvents`.
2. `run_started` moves the run to `in_progress`, and `run_completed` or `run_failed` move it to a terminal status. `dispatch_created` adds or updates a step and sets `current_step`. `artifact_written` appends an artifact, deduplicated by `path`.
3. The result is a fresh state object; the input state and event array are not changed.

### Shared contract alignment

Both folds rely on the shapes that the module shares with the rest of the project through [src/contracts](src-contracts.md), which keeps the agent-related structures compatible with the modules that consume them.

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `AgentEvent`
- `AgentStatus`
- `AgentUsage`
- `AgentRecord`
- `AgentsSnapshot`
- `reduceAgents`
- `AgentDelta`
- `diffAgents`

### Key files

- `src/harness/monitor/reduce.ts` - imported by 7, imports 0
- `src/harness/monitor/reduce-state.test.ts` - imported by 0, imports 3
- `src/harness/monitor/reduce-state.ts` - imported by 1, imports 1
- `src/harness/monitor/reduce.test.ts` - imported by 0, imports 1

### Depended on by

- `src/commands` - 1 import(s)
- `src/harness/external` - 1 import(s)

### Dependency basis

- Production imports only: 3 import(s) from test file(s) (e.g. `src/commands/agents.monitor.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 4
- Cross-module imports: 0

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/external](src-harness-external.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose enriched to describe public data contracts, reduction/diff helpers, and consumer boundaries.

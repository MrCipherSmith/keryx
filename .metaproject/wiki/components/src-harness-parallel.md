---
Title: Module src/harness/parallel
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/parallel` plans child tasks into bounded, dependency-ordered waves with budget reservations, then runs those waves through an injected executor. It depends on `src/harness/child` and exposes nine public symbols."
---
```markdown
---
Title: Module src/harness/parallel
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/parallel` plans child tasks into bounded, dependency-ordered waves with budget reservations, then runs those waves through an injected executor. It depends on `src/harness/child` and exposes nine public symbols."
---

# Module src/harness/parallel

## Summary

`src/harness/parallel` plans child tasks into bounded, dependency-ordered waves with budget reservations, then runs those waves through an injected executor. It depends on `src/harness/child` and exposes nine public symbols.

## Overview

The module owns the wave scheduling layer for child tasks in the harness. A parent describes its children with `dependsOn` edges, budget requests and optional cancellation. The module turns that description into waves: tasks inside one wave run concurrently, and waves run one after another. Planning is pure and fail-closed. Execution is delegated to a caller-supplied `run` function, so the module does not start children itself.

Higher-level code such as `src/harness`, `src/harness/extension` and `src/commands` can therefore depend on this scheduling API without knowing how an individual child is run.

## How it works

The module contains two key files:

- `src/harness/parallel/scheduler.ts` holds the planner, the executor and the error type.
- `src/harness/parallel/scheduler.test.ts` pins the behavior, with tests grouped by acceptance criterion.

Planning (`planWaves`) is synchronous and reads no clock, RNG or filesystem. It runs in two passes:

1. **Structure pass.** Cancelled tasks, and every task that transitively depends on one, are removed first. The remaining tasks are then released wave by wave. A task is ready only when all of its `dependsOn` entries were scheduled in an earlier wave. Ready tasks are sorted by `taskId`, and each wave takes at most `maxConcurrency` of them. If tasks remain but none is ready, the plan is denied as a dependency cycle.
2. **Budget pass.** The planner folds `inheritBudget` from `src/harness/child` across the waves in order. It runs against a `parentRemaining` value that decrements after each grant and carries across waves. One breach denies the whole plan, so a partial plan is never returned.

Execution (`executeWaves`) runs waves strictly in order. Within a wave, it calls the injected `deps.run` for every task through `Promise.allSettled`, so one rejection does not stop its siblings. If any task in the wave rejected, it throws a `WaveExecutionError` once the wave has settled, and no later wave starts. The module adds no retry logic.

## Key concepts

- `ChildTask`: a task with `taskId`, `dependsOn`, `budgetRequest` and optional `cancelled` and `modelRequest`. The model request is passed through without being read by planning.
- `PlanWavesConfig`: `maxConcurrency`, which must be a positive integer or planning is denied, and `parentRemaining`, the budget ceiling for the whole plan.
- `PlanWavesDeps`: holds `idSeq`. It is accepted for forward compatibility, but `planWaves` does not use it.
- `Wave`: `taskIds` plus index-aligned `reservations`, the budget granted to each task.
- `PlanWavesResult`: a discriminated union, either `{ ok: true, waves }` or `{ ok: false, reason }`. A denial never carries partial waves.
- `WaveExecutorDeps`: the injected `run(task, reservation)` function. Ordinary child failures are expected to come back as values rather than rejections.
- `WaveExecutionError`: carries `waveIndex`, `failedTaskIds`, `causes` and `partialResults`, the map of tasks that already succeeded (earlier waves plus same-wave siblings).

Planning returns data and never calls `run`. `executeWaves` is the only function that dispatches work.

## Main flows

### Plan work into waves

A caller passes `ChildTask[]`, a `PlanWavesConfig` and optionally `PlanWavesDeps` to `planWaves`. The function first rejects a non-positive or non-integer `maxConcurrency`. It then computes the exclusion set, forms the waves, folds the budget, and returns either the `Wave[]` or a denial reason. Identical inputs give deep-equal results.

### Execute planned waves

After planning, the caller passes the original tasks, the waves and `WaveExecutorDeps` to `executeWaves`. Each wave entry is looked up by `taskId`. A missing task, or a reservation list that does not line up with the task IDs, becomes a rejected task in that wave. On success the function returns a `Map` from `taskId` to the value `run` returned. On failure it throws `WaveExecutionError`, and the caller can read `partialResults` to keep the tasks that succeeded.

### Validate the scheduler

`scheduler.test.ts` groups its tests by acceptance criterion: bounded waves, dependency ordering, aggregate budget denial, cancellation, cycle denial, degenerate `maxConcurrency`, determinism, and `executeWaves` behavior. The within-wave timing test uses a fake clock, so it never waits on real time.

---

## Reference

### Public API

- `ChildTask` (interface)
- `PlanWavesConfig` (interface)
- `PlanWavesDeps` (interface)
- `Wave` (interface)
- `PlanWavesResult`
- `planWaves` (function)
- `WaveExecutorDeps` (interface)
- `WaveExecutionError` (class)
- `executeWaves` (function)

### Key files

| File | Imports | Importers |
|------|---------|-----------|
| `src/harness/parallel/scheduler.ts` | 2 | 5 |
| `src/harness/parallel/scheduler.test.ts` | 2 | 0 |

### Dependency graph

```
src/harness/child
    └── src/harness/parallel
            ├── src/harness
            ├── src/harness/extension
            └── src/commands
```

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/extension](src-harness-extension.md)
- [Module src/commands](src-commands.md)
- [Module src/harness](src-harness.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose enriched from code-graph reference.
```

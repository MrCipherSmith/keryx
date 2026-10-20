---
Title: Module src/job
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/job` owns the job package behind `keryx job`: the persisted `state.json` vocabulary, the phase, step and completion-gate rules, the default plan per intent, and a service that serializes every change to a job package under a file lock and validates it against the job-orchestrator-state schema before writing."
---

# Module src/job

## Summary

`src/job` owns the record of a job package under `.metaproject/jobs/<name>/`. It defines the shared vocabulary of phases, intents, steps, metrics, documents and status reports, the rules that govern their transitions, and the service that writes each change to `state.json` and `journal.md`.

## Overview

The module owns the domain contract for job execution and its on-disk record. `types.ts` defines what a job is, `machine.ts` defines which moves are legal, `plans.ts` supplies the default plan for each intent, `store.ts` maps job names to paths and performs schema-checked persistence, and `service.ts` combines these into the six operations behind `keryx job`: init, status, step, document, complete and list.

The job-orchestrator skill's resumption contract is served by the `nextStep` field of a status report, which is read from disk rather than recalled. The CLI is the only writer of job state, and the module's end-to-end tests drive it through the real `jobCommand` entry point rather than hand-built state.

## How it works

The module has five layers, each with one responsibility:

- **Contract (`types.ts`)**: the type definitions. Field names are the schema's snake_case names, because the root of `state.json` is `additionalProperties: false`. Step status is stored with an underscore (`in_progress`) and accepted on the command line hyphenated (`in-progress`).
- **Rules (`machine.ts`)**: pure functions with no I/O. They hold the phase and step transition tables, the definition of a terminal step, `firstOpenStep`, flag parsing, and the completion gate `evaluateJobGate`. A `failed` step is not terminal, and a `conditional` step is not exempt from the gate.
- **Templates (`plans.ts`)**: `defaultPlan(intent)` returns fresh pending steps for `implement`, `analyze`, `review` or `custom`. Conditional steps stay in the plan, and a conditional step that did not run must be recorded as `skipped`.
- **Persistence (`store.ts`)**: resolves `.metaproject/jobs/<name>` paths, enforces the job-name pattern before any path is built, reads `state.json`, and writes it only after it validates against the schema loaded through `loadSchema("job-orchestrator-state")`. It also appends lines to `journal.md` and maps document types to file names.
- **Service (`service.ts`)**: `createJobService` takes an injected clock and implements the operations. Every mutation runs through `mutate`, which takes a per-job lock file, reads the state, applies the change, sets `updated_at`, writes the state, and appends a journal line.

Two behaviours are worth noting. The retry counter is persisted in `metrics.steps[].retries`, so a loop bound survives a session restart: the first attempt leaves it at 0, and each re-entry into `in_progress` adds one. The package moves from PLAN to EXECUTION on the first step change, so status never reports PLAN while work is underway.

## Key concepts

- **Job phase**: `JobPhase` is `CONTEXT`, `PLAN`, `EXECUTION` or `COMPLETION`. `PHASE_TRANSITIONS` in `machine.ts` allows PLAN to EXECUTION and EXECUTION to COMPLETION. `init` opens a package in PLAN.
- **Job intent**: `JobIntent` is one of `implement`, `analyze`, `review` or `custom`, listed in `JOB_INTENTS`. It selects the default plan, and `parseIntent` treats an absent value as `implement`.
- **Job step**: `JobStep` carries `id`, `type`, `agent` and `status`, with optional `depends` and `conditional`. `JobStepStatus` is the persisted spelling, and `JobStepStatusFlag` lists the `--status` values the CLI accepts.
- **Job context**: `JobContext` holds `project_dir`, `base_branch` and an optional `JobIssueRef`.
- **Job plan**: `JobPlan` is the ordered `steps` list plus `current_step`, which is kept at the first non-terminal step.
- **Job documentation**: `JobDocumentation` lists `documents_created` as file names. `DOCUMENT_TYPES` fixes four types (`analysis`, `implementation-report`, `review`, `verification-report`). The type is carried in the file name because the schema types the array as strings.
- **Job metrics**: `JobMetrics` holds one `JobStepMetric` row per step. The service writes `retries`, `status`, the start and completion timestamps, and `duration_ms`. The token and total fields are declared in the types but not written by this module.
- **Job state and reporting**: `JobState` is the persisted record. `JobStatusReport` is what `status` returns, including `nextStep`, `open`, `failed`, `retries` and `documents`. `JobSummary` is one row of `list`.
- **Service dependencies**: `JobServiceDeps` injects `now`, so timestamps can be controlled in tests.

## Main flows

### 1. Initialization

`init` rejects an existing package directory and parses the intent. It creates `.metaproject/jobs/<name>/`, builds a `JobState` in PLAN from `defaultPlan(intent)`, and sets `plan.current_step` to the first open step. It writes `journal.md` from `renderJournal`, then writes `state.json` through `writeJob`, which refuses any state that does not validate against the job-orchestrator-state schema.

### 2. Step changes

`step` parses `--status` before opening the package, so a bad value fails without touching disk. Inside `mutate`, `assertStepTransition` checks the step's current status against `STEP_TRANSITIONS`. The step's metric row is then updated: re-entering `in_progress` after an earlier start increments `retries`, and reaching a terminal status or `failed` sets `completed_at` and `duration_ms`. The package phase moves to EXECUTION, `current_step` is recomputed, and the journal receives a `step:` line that includes the retry count.

### 3. Completion, status and documents

`complete` runs `evaluateJobGate` and refuses while any step is open or failed, naming them in the error. Otherwise it moves the package to COMPLETION and removes `current_step`. `status` builds its `JobStatusReport` from the same gate and the metrics, so a resuming agent reads the next step from disk. `document` copies the source file into the package as `<type><source extension>` and records the name once in `documents_created`. `list` returns one `JobSummary` per package whose `state.json` can be read, and skips the rest.

---

<!-- keryx:reference:begin v=1 hash=0554eb59fc674b27b83d435f14e2f6b0831d2bcc96eb996dcae7b0a08822b314 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `JobPhase`
- `JobIntent`
- `JOB_INTENTS`
- `JobStepStatus`
- `STEP_STATUS_FLAGS`
- `JobStepStatusFlag`
- `DOCUMENT_TYPES`
- `JobDocumentType`
- `JobStep`
- `JobStepMetric`
- `JobIssueRef`
- `JobContext`
- `JobPlan`
- `JobDocumentation`
- `JobMetrics`
- `JobState`
- `JobSummary`
- `JobStatusReport`
- `JobServiceDeps`
- `JobInitInput`

### Key files

- `src/job/types.ts` - imported by 8, imports 0
- `src/job/service.ts` - imported by 2, imports 5
- `src/job/store.ts` - imported by 2, imports 4
- `src/job/job.e2e.test.ts` - imported by 0, imports 5
- `src/job/machine.ts` - imported by 3, imports 1
- `src/job/plans.ts` - imported by 3, imports 1

### Depends on

- `src/lib` - 2 import(s)
- `src/contracts` - 1 import(s)
- `src/gdskills` - 1 import(s)

### Depended on by

- `src/commands` - 3 import(s)
- `src` - 1 import(s)

### Dependency basis

- Production imports only: 5 import(s) from test file(s) (e.g. `src/gdskills/agent-catalogue-xref.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 7
- Cross-module imports: 4
<!-- keryx:reference:end -->

## Related pages

- [Wiki Index](../index.md)
- [Module src/commands](src-commands.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/lib](src-lib.md)
- [Module src/contracts](src-contracts.md)
- [Module src](src.md)

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/contracts](src-contracts.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/commands](src-commands.md)
- [Module src](src.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.

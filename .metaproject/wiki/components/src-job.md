---
Title: Module src/job
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/job` groups 7 file(s). Depends on `src/commands`, `src/gdskills`, `src/lib`. Exposes 20 public symbol(s)."
---
# Module src/job

## Summary

`src/job` is the component that defines the shared job model and its supporting vocabulary. It groups job phases, intents, steps, statuses, metrics, documents, plans, state, summaries, and status reports, then exposes those as public symbols for the rest of the application.

## Overview

The module owns the domain contract for job execution and reporting. It provides the core types used to describe what a job is, how it progresses, what documentation belongs to it, and how its status should be summarized.

It is used mainly by job-related commands and skills, which rely on the same job objects to coordinate execution and reporting. By centralizing this vocabulary, `src/job` keeps job orchestration consistent across command handling, skill integration, and shared application state.

## How it works

The module is organized around a small set of related responsibilities:

- `src/job/types.ts` defines the shared domain types used across the module and by external consumers.
- `src/job/service.ts` provides higher-level job-related logic that builds on the shared types.
- `src/job/store.ts` maintains job-related state and related coordination data.
- `src/job/machine.ts` supports transitions between job-related states or step states.
- `src/job/plans.ts` defines reusable job plans or plan structures.
- `src/job/job.e2e.test.ts` exercises the module’s behavior end-to-end using the service, store, machine, plans, and types.

The module depends on `src/commands`, `src/gdskills`, `src/lib`, and `src/contracts`. It is also imported back by `src/commands`, `src/gdskills`, and `src`, which indicates it acts as a shared component used for both command-level orchestration and broader application wiring.

## Key concepts

- **Job phase**  
  Describes the broad lifecycle stage of a job. The module exposes `JobPhase` as part of that vocabulary.

- **Job intent**  
  Describes the purpose or kind of job being tracked. `JobIntent` and `JOB_INTENTS` form the stable intent vocabulary.

- **Job step**  
  Represents a discrete unit of work inside a job. `JobStep` is the primary step abstraction, while `JobStepStatus` and `JobStepStatusFlag` describe its current state.

- **Job context**  
  Provides the execution context for a job. `JobContext` holds information that steps and services may need while interpreting the job.

- **Job plan**  
  Describes how work is organized into steps. `JobPlan` is the main structure for plan-based job execution.

- **Job documentation**  
  Captures documents associated with a job. `JobDocumentation`, `DOCUMENT_TYPES`, and `JobDocumentType` define the document model.

- **Job metrics**  
  Describe measurable aspects of jobs and steps. `JobMetrics` and `JobStepMetric` are the shared metric types.

- **Job state and reporting**  
  `JobState`, `JobSummary`, and `JobStatusReport` are the primary status-facing objects used to represent current job progress and communicate outcomes.

## Main flows

The following flows describe how the module’s public concepts relate. They are high-level conceptual flows rather than a description of exported functions, because the code graph provides types and files rather than full implementation details.

### 1. Job initialization and setup

A caller starts with `JobInitInput` and `JobServiceDeps`. These public types suggest that job creation requires:

- caller-supplied initialization data,
- service dependencies required to operate on the job.

During initialization, the module builds a job model from the shared types, including:

- `JobContext`
- `JobPlan`
- `JobState`
- `JobSummary` or `JobStatusReport`, depending on what the caller needs

This lets commands and skills start working with a consistent job representation from the beginning of execution.

### 2. Step execution and status tracking

Once a job exists, its work is represented as steps. The core objects in this flow are:

- `JobStep`
- `JobStepStatus`
- `JobStepStatusFlag`
- `JobStepMetric`

Conceptually:

1. A job plan contains or references steps.
2. Each step has a status and optional flags.
3. Step progress may be recorded through metrics.
4. Status transitions are represented through the job’s state model.

`src/job/machine.ts` supports this flow by representing the transition-oriented part of job handling, while `src/job/store.ts` helps keep the current state available to other parts of the system.

### 3. Status reporting and documentation

The reporting flow centers on the status-facing types:

- `JobState`
- `JobSummary`
- `JobStatusReport`
- `JobDocumentation`
- `JobDocumentType`
- `DOCUMENT_TYPES`

In practice, this flow allows the rest of the application to:

- summarize current job progress,
- expose structured status data,
- attach or classify documentation associated with the job,
- present consistent job outcomes to commands, skills, or other consumers.

This makes `src/job` both an execution model and a reporting contract.

---

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

- `src/commands` - 2 import(s)
- `src/gdskills` - 2 import(s)
- `src/lib` - 2 import(s)
- `src/contracts` - 1 import(s)

### Depended on by

- `src/commands` - 3 import(s)
- `src/gdskills` - 2 import(s)
- `src` - 1 import(s)

### Graph signals

- Files: 7
- Cross-module imports: 7

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/commands](src-commands.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/lib](src-lib.md)
- [Module src/contracts](src-contracts.md)
- [Module src](src.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.

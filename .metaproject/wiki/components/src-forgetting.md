---
Title: Module src/forgetting
Version: "0.1.0"
Type: component
Status: draft
Summary: "`src/forgetting` groups 8 file(s). Depends on `src/gdgraph`, `src/wiki`, `src/retention`. Exposes 20 public symbol(s)."
---
# Module src/forgetting

## Summary

`src/forgetting` groups 8 file(s). Depends on `src/gdgraph`, `src/wiki`, `src/retention`. Exposes 20 public symbol(s).

## Overview

`src/forgetting` owns the “forgetting” layer for recorded knowledge. It models what has been removed, what is absent, and why that absence is known, then exposes reconciliation and lookup primitives to other parts of the system.

The module is designed to sit between knowledge persistence and knowledge consumers. It can read deletion evidence from a journal, interpret it as a forgetting trail, explain coverage and attribution for removals, and help callers understand how a missing graph target or wiki page relates to existing forgetting records.

Its dependencies suggest a focused role:

- `src/gdgraph` for graph-target related knowledge state
- `src/wiki` for wiki-page related knowledge state
- `src/retention` for retention-aware interpretation of removals
- `src/commands` and `src/harness/tool` as primary callers

## How it works

The module is organized around a small set of cooperating abstractions.

### Public service layer

`src/forgetting/service.ts` is the main coordination point. It exposes the reconciliation API, including:

- `ForgettingReconcileInput`
- `ForgettingReconcile`
- `reconcileForgetting`

This layer is likely where callers enter the forgetting subsystem and receive a structured outcome describing what the module concluded about a removal or absence.

### Persistence and evidence

`src/forgetting/journal.ts` handles the deletion-journal boundary. The public symbols suggest that this file provides:

- a path helper or path constant for the deletion journal: `deletionJournalPath`
- a reader for the journal: `readDeletionJournal`

The journal appears to be the low-level record from which higher-level forgetting state is derived.

### Trail interpretation

`src/forgetting/trail.ts` interprets deletion evidence as a `ForgettingTrail`. This is where the module appears to support:

- trail loading via `loadDeletionTrail`
- search and lookup via `searchRemovals` and `lookupRemoval`
- coverage reporting via `trailCoverage` and `describeCoverageAgainst`
- descriptive output via `describeRemovalLookup`, `describeOccurrence`, and related explainers

This layer turns stored removal data into an actionable model of what has been forgotten.

### Identity and attribution

`src/forgetting/identity.ts` appears to define the identity and attribution model used when explaining removals:

- `RemovedIdentity`
- `RemovalAttribution`
- `describeAttribution`

This is where the module likely distinguishes between:

- what was removed
- what kind of knowledge layer it belonged to
- what can be attributed to a removal record

### Propagation into dependent layers

`src/forgetting/propagation.ts` connects the forgetting model to other knowledge layers. Given its dependencies on `src/gdgraph`, `src/wiki`, and `src/retention`, this file likely helps translate forgetting outcomes into context relevant to graph targets, wiki pages, or retention rules.

The public explainers suggest it is not only about mutation, but also about explanation:

- `explainAbsentGraphTarget`
- `explainAbsentWikiPage`
- `describeAttribution`
- `describeCoverageAgainst`

### Tests

`src/forgetting/journal.test.ts` verifies journal behavior. This is useful because journal loading is a boundary between durable state and in-memory interpretation.

## Key concepts

### Forgetting trail

A `ForgettingTrail` is the module’s central model of removal state. It is derived from journal data and can be searched, looked up, and described.

### Deletion journal

The deletion journal is the low-level evidence store. It is represented by paths and readers such as:

- `deletionJournalPath`
- `readDeletionJournal`

### Removed identity

`RemovedIdentity` names the thing that was removed. This is likely the anchor for looking up and attributing removals.

### Removal attribution

`RemovalAttribution` explains how a removal is understood in context, especially across different knowledge layers.

### Knowledge layer

`KnowledgeLayer` captures the kind of knowledge domain in which a removal occurred, such as graph or wiki knowledge.

### Coverage

Coverage describes how well the current forgetting trail accounts for a requested lookup or set of knowledge targets. It is exposed through:

- `trailCoverage`
- `describeCoverageAgainst`
- `TRAIL_SCOPE_CAVEAT`

### Reconciliation

Reconciliation is the module’s core service operation. It takes a `ForgettingReconcileInput` and produces a `ForgettingReconcile`, summarizing the result of the forgetting process.

## Main flows

### 1. Reconcile a forgetting request

A caller enters through `reconcileForgetting` using `ForgettingReconcileInput`.

1. The caller constructs a reconciliation request.
2. `service.ts` receives the request.
3. The service reads journal state through `journal.ts`.
4. Journal contents are interpreted as a `ForgettingTrail`.
5. The result is returned as a `ForgettingReconcile`.

This is the primary entry point for higher-level forgetting behavior.

### 2. Look up or search removals

Callers can inspect removal records using the trail API.

1. A caller invokes `lookupRemoval` or `searchRemovals`.
2. The trail layer uses journal data to find matching removals.
3. Results are described using helpers such as:
   - `describeRemovalLookup`
   - `describeAttribution`
   - `describeOccurrence`

This flow is likely used for diagnostics, audit views, and command surfaces.

### 3. Explain an absent graph or wiki target

When a caller asks why something is missing, the module can explain the absence in terms of the forgetting trail.

1. A caller asks whether a graph target or wiki page is absent.
2. The module evaluates trail coverage and related attribution state.
3. The result is expressed through explainers such as:
   - `explainAbsentGraphTarget`
   - `explainAbsentWikiPage`
   - `describeCoverageAgainst`

This flow makes the module useful not only for tracking deletions, but also for explaining missing knowledge.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `ForgettingReconcileInput`
- `ForgettingTrail`
- `ForgettingReconcile`
- `reconcileForgetting` (function)
- `deletionJournalPath`
- `readDeletionJournal`
- `TRAIL_SCOPE_CAVEAT`
- `describeAttribution`
- `describeCoverageAgainst`
- `describeOccurrence`
- `describeRemovalLookup`
- `explainAbsentGraphTarget`
- `explainAbsentWikiPage`
- `loadDeletionTrail`
- `lookupRemoval`
- `searchRemovals`
- `trailCoverage`
- `KnowledgeLayer`
- `RemovalAttribution`
- `RemovedIdentity`

### Key files

- `src/forgetting/service.ts` - imported by 6, imports 4
- `src/forgetting/propagation.ts` - imported by 2, imports 7
- `src/forgetting/journal.ts` - imported by 6, imports 1
- `src/forgetting/trail.ts` - imported by 2, imports 4
- `src/forgetting/identity.ts` - imported by 1, imports 3
- `src/forgetting/journal.test.ts` - imported by 0, imports 3

### Depends on

- `src/gdgraph` - 6 import(s)
- `src/wiki` - 5 import(s)
- `src/retention` - 2 import(s)
- `src/lib` - 2 import(s)
- `src/memory` - 2 import(s)

### Depended on by

- `src/commands` - 7 import(s)
- `src/harness/tool` - 1 import(s)

### Graph signals

- Files: 8
- Cross-module imports: 17

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/wiki](src-wiki.md)
- [Module src/retention](src-retention.md)
- [Module src/lib](src-lib.md)
- [Module src/memory](src-memory.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/tool](src-harness-tool.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.

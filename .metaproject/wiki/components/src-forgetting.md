---
Title: Module src/forgetting
Version: "0.1.0"
Type: component
Status: draft
Summary: "`src/forgetting` groups 8 file(s). Depends on `src/gdgraph`, `src/wiki`, `src/retention`. Exposes 20 public symbol(s)."
---
```markdown
---
Title: Module src/forgetting
Version: "0.1.0"
Type: component
Status: accepted
Summary: "`src/forgetting` groups 8 file(s). Depends on `src/gdgraph`, `src/wiki`, `src/retention`. Exposes 20 public symbol(s)."
---

# Module src/forgetting

## Overview

The `src/forgetting` module owns the "forgetting" layer for recorded knowledge. It models what has been removed, what is absent, and why that absence is known, then exposes reconciliation and lookup primitives to other parts of the system.

The module sits between knowledge persistence and knowledge consumers. It can:

- Read deletion evidence from a journal
- Interpret evidence as a forgetting trail
- Explain coverage and attribution for removals
- Help callers understand how a missing graph target or wiki page relates to existing forgetting records

### Dependencies

The module depends on related knowledge layers:

| Module | Purpose |
|--------|---------|
| `src/gdgraph` | Graph-target related knowledge state |
| `src/wiki` | Wiki-page related knowledge state |
| `src/retention` | Retention-aware interpretation of removals |

Primary callers are `src/commands` and `src/harness/tool`.

## Architecture

The module is organized into layers with distinct responsibilities.

### Public Service Layer

`src/forgetting/service.ts` is the main coordination point. It exposes the reconciliation API:

- `ForgettingReconcileInput`
- `ForgettingReconcile`
- `reconcileForgetting`

### Persistence and Evidence

`src/forgetting/journal.ts` handles the deletion journal boundary:

- `deletionJournalPath` - path helper or constant for the deletion journal
- `readDeletionJournal` - journal reader

The journal is the low-level record from which higher-level forgetting state is derived.

### Trail Interpretation

`src/forgetting/trail.ts` interprets deletion evidence as a `ForgettingTrail`:

- `loadDeletionTrail` - trail loading
- `searchRemovals`, `lookupRemoval` - search and lookup
- `trailCoverage`, `describeCoverageAgainst` - coverage reporting
- `describeRemovalLookup`, `describeOccurrence` - descriptive output

### Identity and Attribution

`src/forgetting/identity.ts` defines the identity and attribution model:

- `RemovedIdentity` - names the thing that was removed
- `RemovalAttribution` - explains how a removal is understood in context
- `describeAttribution` - human-readable attribution description

This layer distinguishes between what was removed, its knowledge layer, and what can be attributed to a removal record.

### Propagation

`src/forgetting/propagation.ts` connects the forgetting model to other knowledge layers. It translates forgetting outcomes into context relevant to graph targets, wiki pages, or retention rules:

- `explainAbsentGraphTarget`
- `explainAbsentWikiPage`
- `describeCoverageAgainst`

## Key Concepts

### Forgetting Trail

A `ForgettingTrail` is the module's central model of removal state. It is derived from journal data and can be searched, looked up, and described.

### Deletion Journal

The deletion journal is the low-level evidence store:

- `deletionJournalPath` - journal path
- `readDeletionJournal` - journal reader

### Removed Identity

`RemovedIdentity` names the thing that was removed. This is the anchor for looking up and attributing removals.

### Removal Attribution

`RemovalAttribution` explains how a removal is understood in context across different knowledge layers.

### Knowledge Layer

`KnowledgeLayer` captures the kind of knowledge domain in which a removal occurred (e.g., graph or wiki knowledge).

### Coverage

Coverage describes how well the current forgetting trail accounts for a requested lookup or set of knowledge targets:

- `trailCoverage`
- `describeCoverageAgainst`
- `TRAIL_SCOPE_CAVEAT`

### Reconciliation

Reconciliation is the module's core service operation. It takes a `ForgettingReconcileInput` and produces a `ForgettingReconcile`.

## Main Flows

### Reconcile a Forgetting Request

1. Caller constructs a reconciliation request with `ForgettingReconcileInput`
2. `service.ts` receives the request
3. The service reads journal state through `journal.ts`
4. Journal contents are interpreted as a `ForgettingTrail`
5. Result is returned as a `ForgettingReconcile`

### Look Up or Search Removals

1. Caller invokes `lookupRemoval` or `searchRemovals`
2. Trail layer uses journal data to find matching removals
3. Results are described using helpers:
   - `describeRemovalLookup`
   - `describeAttribution`
   - `describeOccurrence`

This flow supports diagnostics, audit views, and command surfaces.

### Explain an Absent Target

When a caller asks why something is missing:

1. Caller asks whether a graph target or wiki page is absent
2. Module evaluates trail coverage and attribution state
3. Result expressed through explainers:
   - `explainAbsentGraphTarget`
   - `explainAbsentWikiPage`
   - `describeCoverageAgainst`

## Reference

### Public API

- **Types**: `ForgettingReconcileInput`, `ForgettingTrail`, `ForgettingReconcile`, `KnowledgeLayer`, `RemovalAttribution`, `RemovedIdentity`
- **Functions**: `reconcileForgetting`, `deletionJournalPath`, `readDeletionJournal`, `describeAttribution`, `describeCoverageAgainst`, `describeOccurrence`, `describeRemovalLookup`, `explainAbsentGraphTarget`, `explainAbsentWikiPage`, `loadDeletionTrail`, `lookupRemoval`, `searchRemovals`, `trailCoverage`
- **Constants**: `TRAIL_SCOPE_CAVEAT`

### File Inventory

| File | Imports | Exporters |
|------|---------|-----------|
| `src/forgetting/service.ts` | 4 | 6 |
| `src/forgetting/propagation.ts` | 7 | 2 |
| `src/forgetting/journal.ts` | 1 | 6 |
| `src/forgetting/trail.ts` | 4 | 2 |
| `src/forgetting/identity.ts` | 3 | 1 |
| `src/forgetting/journal.test.ts` | 3 | 0 |

### Module Dependencies

- `src/gdgraph` - 6 import(s)
- `src/wiki` - 5 import(s)
- `src/retention` - 2 import(s)
- `src/lib` - 2 import(s)
- `src/memory` - 2 import(s)

### Dependents

- `src/commands` - 7 import(s)
- `src/harness/tool` - 1 import(s)

## Related

- [Module src/gdgraph](src-gdgraph.md)
- [Module src/wiki](src-wiki.md)
- [Module src/retention](src-retention.md)
- [Module src/lib](src-lib.md)
- [Module src/memory](src-memory.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/tool](src-harness-tool.md)
- [Wiki Index](../index.md)
```

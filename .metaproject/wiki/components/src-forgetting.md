---
Title: Module src/forgetting
Version: "1.0.0"
Type: component
Status: accepted
Summary: "`src/forgetting` owns the deletion trail: it records what knowledge was removed, reconciles the wiki identity layer, and explains absent wiki pages and graph targets. Depends on `src/gdgraph`, `src/wiki`, `src/retention`. Exposes 20 public symbol(s)."
---

# Module src/forgetting

## Overview

The `src/forgetting` module owns the deletion trail for recorded knowledge. It keeps an append-only record of what was removed, when, by whose request and on what grounds, in its own file tree, so that deleting the knowledge does not delete the evidence of the deletion. Its facade in `src/forgetting/service.ts` runs a reconcile after a removal: it writes wiki identity tombstones, reports every knowledge layer with a cause, and appends a deletion record when the run actually removed something. Other surfaces read the trail to say why a wiki page or graph target is absent.

### Dependencies

| Module | Purpose |
|--------|---------|
| `src/gdgraph` | Code graph access and dangling-edge detection (`loadGraph`, `getDanglingEdges`, `namesDeletedFile`) |
| `src/wiki` | Section registry and page collection (`syncSectionRegistry`, `readSectionRegistryState`, `resolveSectionIdentity`) |
| `src/memory` | Memory entries and cross-layer references to wiki knowledge (`collectEntries`, `checkMemoryCrossLayer`) |
| `src/lib` | Filesystem helpers (`isNotFound`, `pathExists`) |
| `src/retention` | Retention policy; a journal test pins that retention never sweeps the deletion journal |

Primary callers are `src/commands` and `src/harness/tool`.

## How it works

The module is a facade over three internal concerns: a journal that holds the evidence, a write path that records identity tombstones, and read-side interpretation that turns the journal and live stores into answers. Dependencies point inward toward the journal, and the facade is the only entry point the transports use.

- **Facade.** `src/forgetting/service.ts` exposes `reconcileForgetting`, which takes a `ForgettingReconcileInput` and returns a `ForgettingReconcile`. It sequences the work, and the order matters: the identity layer is written first, so the propagation report describes the state the run leaves behind rather than the state it found. The facade re-exports the read-side functions so callers never import internals of this directory.
- **Journal.** `src/forgetting/journal.ts` owns `.metaproject/data/forgetting/journal.jsonl`. Its only write is `appendDeletionRecord`; there is no function that rewrites the file. Reads return a three-state `JournalRead` (`absent`, `present`, `unreadable`), so a damaged file is never mistaken for an empty history. The same file defines attribution: an `Attribution` carries a basis of `stated`, `derived` or `unknown`, and `resolveRequestedBy` and `resolveGrounds` never promote a git identity into a stated requester.
- **Identity layer.** `src/forgetting/identity.ts` is the one layer the reconcile writes. `applyIdentityLayer` collects pages, builds the section index and calls `syncSectionRegistry`, which only adds tombstones. It returns `tombstonedNow`, the refs this run produced, so a record can claim only its own removals.
- **Propagation report.** `src/forgetting/propagation.ts` deliberately does not cascade a deletion into other layers. `reportPropagation` builds one `LayerOutcome` per `KnowledgeLayer` (wiki identity, wiki index, wiki freshness, memory, graph, SAC evidence). Each outcome is `examined`, `failed` or `not-examined`, and lists dangling references with their causes. Memory entries and graph edges are reported, not changed.
- **Trail reads.** `src/forgetting/trail.ts` loads the journal into a `DeletionTrail`, measures `trailCoverage`, and answers lookups with verdicts such as `recorded-removed`, `no-removal-recorded`, `trail-absent` and `trail-unreadable`. Every "no record" answer carries `TRAIL_SCOPE_CAVEAT`, because the trail holds only removals that a reconcile observed. `explainAbsentWikiPage` and `explainAbsentGraphTarget` combine the section registry, the trail and the graph's unresolved imports.

## Key concepts

### Forgetting Trail

The name covers two related types. `ForgettingTrail` in `service.ts` is the outcome of one reconcile run: `not-a-write` (report-only run), `nothing-removed`, or `recorded`. `DeletionTrail` in `trail.ts` is the journal as it stands on disk, in the `absent`, `present` or `unreadable` states.

### Deletion Journal

The journal is the low-level evidence store. Each `DeletionRecord` carries a version `v` (currently `DELETION_JOURNAL_VERSION` = 2), `at`, `observedBy`, an `outcome` of `propagated`, `reported-only` or `refused`, the `removed` and `observedUnrecorded` lists, `untouched` layers with causes, `requestedBy`, `grounds`, `danglingAfter` and `refusals`. In version 2, `removed` means only what the recording run removed. Version 1 records are still read but never rewritten.

### Removed Identity

`RemovedIdentity` names a thing the wiki no longer carries. Its `state` is `tombstoned` (recorded) or `pending` (gone from disk, not yet recorded). Its `recordedBy` is a `RemovalAttribution`: `this-run`, `an-earlier-run` or `not-recorded`. Only `this-run` may be reported as the act of the current run.

### Attribution

`Attribution` (in `journal.ts`) answers "at whose request" and "on what grounds". A value is `stated` when a person supplied it (`--actor`, `KERYX_ACTOR`, `--reason`), `derived` when the machine inferred it, and `unknown` when nothing was available. `describeAttribution` in `trail.ts` renders it so a derived value is never shown as a stated one.

### Knowledge Layer

`KnowledgeLayer` is the set of layers a reconcile accounts for: `wiki-identity`, `wiki-index`, `wiki-freshness`, `memory`, `graph` and `sac-evidence`. A layer missing from the report would read as checked and clean, so each one appears, even when it is not inspected.

### Coverage

`trailCoverage` measures what the trail can speak to: how many records exist, which layers have ever had a removal recorded (`layersWithRemovals`), and which layers every record lists as untouched (`layersRecordedUntouched`). Silence about a layer the trail has never recorded carries little weight, and `describeCoverageAgainst` says so.

### Deletion Window

`DeletionWindow` tells the graph layer which code files were deleted since the graph was built. It is either `determined` (the deleted list may be empty, which is a real answer) or `undetermined` (with a cause). When the window is undetermined and unresolved in-project imports exist, the graph layer is a failed inspection, so the run cannot report `clean`.

### Reconciliation

Reconciliation is the module's core operation. It applies or observes the identity layer, builds the propagation report, and appends a deletion record only when something was removed or refused.

## Main flows

### Reconcile a removal (`keryx sync --apply`)

1. The caller builds a `ForgettingReconcileInput` with `apply`, `at`, `observedBy`, the stated reason and actor, the deletion window and `graphRebuilt`.
2. With `apply` set, `applyIdentityLayer` writes tombstones through `syncSectionRegistry`. A refusal is kept as `identity.refusal`, not reported as success. Without `apply`, `reportOnlyIdentityOutcome` is used and nothing is written.
3. `reportPropagation` loads the wiki knowledge view, collects removed identities, asks `resolveSectionIdentity` what each one now answers, and builds the six layer outcomes.
4. If the run removed nothing and refused nothing, the result is `nothing-removed` and no record is appended. A report-only run returns `not-a-write`.
5. Otherwise `resolveRequestedBy` and `resolveGrounds` assign attribution, and `appendDeletionRecord` appends one record. A failed append is returned as a named failure, so the caller never reports a deletion as recorded when it was not.

### Look up or search removals

1. A caller invokes `lookupRemoval` with exact candidate identities, optionally filtered to one layer, or `searchRemovals` with a phrase.
2. `lookupRemoval` matches only the `ref` or `page` of removed items, with no fuzzy fallback. `searchRemovals` matches `title`, `ref` or `page` and labels each hit with `matchedOn`.
3. The result is rendered with `describeRemovalLookup`, which uses `describeOccurrence` and `describeAttribution`. The output is tagged with its verdict, so a reader sees the machine answer first.

This flow supports diagnostics, audit views and command surfaces such as `keryx forgetting lookup`.

### Explain an absent target

1. For a wiki path, `explainAbsentWikiPage` checks the section registry first. A `tombstoned` entry, a `pending-tombstone` entry or an unreadable registry is answered directly. Otherwise it falls back to the trail.
2. For a graph target, `explainAbsentGraphTarget` looks up the trail restricted to the `graph` layer, then finds unresolved in-project imports that name the path using `getDanglingEdges` and `namesDeletedFile`.
3. Imports that still name the path give the verdict `referenced-but-unindexed`. This is evidence against "never existed", not proof of removal, because a misspelled import produces the same edge.

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

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.

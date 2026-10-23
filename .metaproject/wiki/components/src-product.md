# Module src/product

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/product` builds the product intent index: it reads each flow package under `.metaproject/flows/` and each requirements package under `docs/requirements/` into a disposable, deterministic `IntentIndex` stored at `.metaproject/data/product/index.json`. It depends on `src/flow` and `src/lib` and exposes its public surface through `service.ts`.

## Overview

The module owns the product's intent as a derived index rather than a hand-maintained record. Each flow or requirements package is read into an `Intent` that carries its title, one-sentence statement, outcome criterion and any recorded `outcome-observed` verdict. Nothing here is edited by hand and nothing gates on the result; the index exists so that surfaces such as `product open` and the TUI can say what the product set out to do and what has been observed to help.

## How it works

The module is a pure core with thin filesystem edges. `extract.ts` turns the text of one package into an `Intent` without any I/O or clock (`extractFlowIntent`, `extractDocpackIntent`, `observationFrom`, `observationProblem`, `docpackObservationProblem`). `corpus.ts` is the only reader of the tree: `buildIntentIndex` walks the flow and requirements packages through `listFlowPackages` and `readSource`, collects per-package failures instead of throwing, sorts the intents, and tallies them with `countsOf`. `corpusFingerprint` hashes the content of every source the index reads.

`store.ts` owns the on-disk form. `writeIntentIndex` writes atomically through `writeFileAtomic`; `readIntentIndex` returns an `absent`, `malformed` or `present` state, and `indexProblem` validates each field the readers touch before an index is trusted. `checkStaleness` compares fingerprints rather than modification times. `types.ts` holds the shared shapes (`Intent`, `IntentOutcome`, `IntentIndex`, `OutcomeVerdict`). `service.ts` is the facade: the CLI adapter and the TUI reach the module only through it, so no sibling file is imported from outside `src/product`.

## Key concepts

- **Intent**: one unit of product intent, read from a flow (`source: "flow"`) or a requirements package (`source: "docpack"`). Its `id`, `path` and `title` identify it; `statement` is `null` when the package states none.
- **Outcome criterion**: the bullets of an `Outcome criteria` section, joined with ` | `. A criterion counts as an instrument unless every bullet is a `not measured` line (`hasInstrument`); `NO_INSTRUMENT` is the stated text for the absence.
- **Observation and verdict**: a flow records an observation as an `outcome-observed: <verdict> — <note>` line in its journal; a requirements package records one as a `- <verdict> — <note>` line under `## Outcome observations`. The four verdicts are `helped`, `no-effect`, `harmed` and `inconclusive`. A malformed line is reported as a failure, but the intent is kept and treated as not observed, so a typo never hides an intent.
- **Status**: a flow is `closed` only when its flow status is `done`; a requirements package is always `open`.
- **Counts**: `IntentCounts` partitions closed intents into `noCriterion`, `notObserved` and `observed`, and the observed ones into the four verdicts.
- **Fingerprint**: a sha256 over the sorted paths and content digests of the sources read, plus the package names. It is what makes an index stale.
- **Origin and outcome author**: labels read from `flow.json` (`origin`, `outcomeAuthor`). They are optional and only label the output; nothing gates on them.

## Main flows

1. **Building the index.** `buildIntentIndex(cwd)` takes the fingerprint before reading any source, so an edit made during the build reads as stale later. For each flow package it reads `flow.json` (a missing one is a failure), then the description, criteria and journal, and passes them to `extractFlowIntent`. For each requirements package it picks the primary document, reads the specification and README, and calls `extractDocpackIntent`. The intents are sorted by `compareIntents` (flows first, then numeric id), and `countsOf` tallies them. The caller serializes the result with `serializeIndex` and persists it with `writeIntentIndex` to `indexPath`.
2. **Reading the index back.** `readIntentIndex` loads `index.json`. If the file is absent it returns `absent`; if the JSON is invalid or `indexProblem` finds a field the readers use to be wrong, it returns `malformed` with the reason. Only a `present` result carries an index to use.
3. **Checking staleness.** `checkStaleness` recomputes `corpusFingerprint` and compares it with `index.fingerprint`. If they match, the index is current. If not, it compares the number of flow packages on disk with the flows the index holds (plus any flow named only in its failures) and reports a count mismatch where one exists; otherwise it reports that the flows or requirements changed. It only reports and refuses nothing.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `buildIntentIndex`
- `corpusFingerprint`
- `NO_INSTRUMENT`
- `g1aByOrigin`
- `g1aLines`
- `buildOpenReport`
- `loadOpenReport`
- `openEntryLines`
- `openHeaderLines`
- `renderIndexSummary`
- `renderOpen`
- `checkStaleness`
- `indexPath`
- `productDataRoot`
- `readIntentIndex`
- `serializeIndex`
- `writeIntentIndex`
- `flowsDir`
- `requirementsDir`
- `listFlowPackages`

### Key files

- `src/product/service.ts` - imported by 15, imports 6
- `src/product/corpus.ts` - imported by 16, imports 2
- `src/product/store.ts` - imported by 12, imports 4
- `src/product/extract.ts` - imported by 9, imports 3
- `src/product/never-gates.test.ts` - imported by 0, imports 10
- `src/product/types.ts` - imported by 6, imports 2

### Depends on

- `src/flow` - 7 import(s)
- `src/lib` - 1 import(s)

### Depended on by

- `src/commands` - 1 import(s)
- `src/tui` - 1 import(s)

### Dependency basis

- Production imports only: 35 import(s) from test file(s) (e.g. `src/commands/flow-init-intent-note.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 21
- Cross-module imports: 8

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/flow](src-flow.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.

---
Title: Module src/wiki/freshness
Version: 1.0.1
Type: component
Status: accepted
Summary: "`src/wiki/freshness` groups 12 file(s). Depends on `src/gdgraph`, `src/wiki`, `src/sync`. Exposes 13 public symbol(s)."
---
# Module src/wiki/freshness

## Overview

`src/wiki/freshness` answers one question for each wiki page: has the code the page describes changed since someone last verified the page? It runs the `keryx wiki freshness` pipeline, which reads a revision range of changes, classifies each changed file by kind of change, works out which pages those changes put in doubt, and writes a report. The report is read-only: it never edits a page and never exits non-zero, so it works as a backlog rather than a CI gate.

## How it works

The main stages live in four files, each with one job (`propagate.ts` and `queue.ts` support them):

- `run.ts` orchestrates. `runFreshness` picks the base revision (an explicit `since`, else the earliest entry in the drained queue, else `HEAD~1`), collects changed files with `git diff --name-status -M`, and reads each file's content before and after the range through `showFile` and `readCurrent`. It then persists `latest.json` and `latest.md` under `freshnessDir`, and clears the queue only after that write succeeds. `previewFreshness` runs the same stages for an explicit range without those side effects. `run.ts` also owns `renderMarkdown`, which hides `fyi` rows unless `all` is passed; the data stays complete in `latest.json`.
- `classify-change.ts` turns each file pair into a `ClassifiedChange` through `classifyChanges`. There are six classes: `added`, `removed`, `moved`, `signature`, `body` and `cosmetic`. Cosmetic is detected by comparing sources with comments and whitespace stripped. `signature` needs a symbol extractor; without one the module never claims `signature` and the report carries a `symbol-layer-unavailable` limitation instead.
- `report.ts` holds the decision logic in `buildFreshnessReport`. For each wiki page it resolves the describe-set, flags a page as `orphan` when every describe path sits in a module that no longer exists, propagates the changed files through the code graph to find affected pages, and combines that with the page's own freshness evaluation. It also totals the results and declares limitations.
- `page-freshness.ts` decides how one page is measured in `evaluatePageFreshness`. The basis it chooses sets the strongest confidence a finding from that page may carry.

## Key concepts

- **RunFreshnessInput**: the options for a run: `cwd`, an optional `since` base, and injectable `git` and `now`. Because `git` is injectable, tests need no repository.
- **FreshnessBasis**: `"git-log" | "scope-hash" | "undecidable"`. `git-log` applies when the page's `VerifiedAt` commit exists in this history; it yields a commit count (`commitsBehind`) and may reach `must-refresh`. `scope-hash` applies when only `VerifiedScope` is available; it is a binary changed-or-not answer, so it is capped at `review-suggested`. `undecidable` means neither is available, and it is deliberately not treated as fresh.
- **PageFreshness**: the per-page result: `basis`, `changed`, `commitsBehind`, `changedFiles`, `confidenceCap`, and an optional `gitFailure`, set only when git could not answer.
- **GitRunner**: `(cwd, args) => Promise<GitCmdResult>`. It returns a kind-tagged result rather than `null`, so a git failure can be told apart from a legitimate negative answer such as a commit missing from history.
- **ChangeClass and ClassifiedChange**: the change kind for one file, plus the names of symbols whose signature changed.
- **FreshnessReport, ReportEntry and Category**: the report envelope, one row per affected page, and the row's category: `stale-reference`, `stale-prose`, `orphan` or `unknown`. The `Category` type also lists `undocumented`, but nothing in these files appears to produce it.
- **Confidence**: `must-refresh`, `review-suggested` or `fyi`, ordered strongest to weakest.
- **Limitation and LimitationCode**: what the report could not see, such as `graph-stale`, `not-a-git-repository` or `unresolved-edges-present`. An absent graph yields an empty report with a `graph-stale` limitation rather than marking every page stale.

## Main flows

1. **Full run.** `runFreshness` probes `git rev-parse HEAD`, drains the queue, and collects the changed files for the range. Each file goes through `classifyChanges`; `loadGraph` loads the code graph; `buildFreshnessReport` assembles the report. `persist` writes it, and the queue is cleared last.
2. **Per-page evaluation.** For each wiki page, `buildFreshnessReport` resolves the describe-set. A page with no describe paths is counted either as not code-scoped (`Describes: none`) or as undecidable. Otherwise `evaluatePageFreshness` runs. When the git-log basis shows the page's own scope unchanged but a dependency moved, the result is an `fyi` `stale-prose` row. Otherwise `categorise` picks `stale-prose` if a changed symbol is named in the page's prose, `stale-reference` for shape changes (signature, added, removed, moved), and `stale-prose` otherwise.
3. **Git-log check.** `revisionExists` runs `git cat-file -e <VerifiedAt>^{commit}`. On failure it re-probes with `git rev-parse --git-dir`. If that succeeds, the commit is absent from this history (for example after a rebase or in a shallow clone), and the page falls back to the `VerifiedScope` hash. If the repository cannot be reached, the page is `undecidable` with a `gitFailure` and is reported as `unknown`.

## Dependencies

| Module | Role |
|--------|------|
| `src/gdgraph` | Graph-based evidence and code context |
| `src/wiki` | Page-oriented context |
| `src/sync` | Synchronization state |
| `src/gdgraph/treesitter` | Parsed source structure for graph signals |
| `src/lib` | Shared utilities |
| `src/capability` | Capability definitions |

---

<!-- keryx:reference:begin v=1 hash=27795889ac14f74ea08797de7195e3f0802087f59e6086290f5eb4e0174e17a3 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `RunFreshnessInput`
- `freshnessDir`
- `runFreshness`
- `PreviewFreshnessInput`
- `previewFreshness`
- `renderMarkdown`
- `Category`
- `LimitationCode`
- `ReportEntry`
- `Limitation`
- `FreshnessReport`
- `BuildReportInput`
- `buildFreshnessReport`

### Key files

- `src/wiki/freshness/run.ts` - imported by 3, imports 11
- `src/wiki/freshness/report.ts` - imported by 3, imports 7
- `src/wiki/freshness/page-freshness.ts` - imported by 6, imports 3
- `src/wiki/freshness/classify-change.ts` - imported by 6, imports 2
- `src/wiki/freshness/report.test.ts` - imported by 0, imports 5
- `src/wiki/freshness/page-freshness.test.ts` - imported by 0, imports 4

### Depends on

- `src/gdgraph` - 7 import(s)
- `src/wiki` - 4 import(s)
- `src/gdgraph/treesitter` - 2 import(s)
- `src/sync` - 2 import(s)
- `src/lib` - 2 import(s)
- `src/capability` - 1 import(s)

### Depended on by

- `src/review` - 2 import(s)
- `scripts/benchmark` - 1 import(s)
- `src/commands` - 1 import(s)

### Dependency basis

- Production imports only: 8 import(s) from test file(s) (e.g. `scripts/benchmark/run-wiki-freshness-scale.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 12
- Cross-module imports: 18
<!-- keryx:reference:end -->

## Related Pages

- [Wiki Index](../index.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/wiki](src-wiki.md)
- [Module src/sync](src-sync.md)
- [Module src/gdgraph/treesitter](src-gdgraph-treesitter.md)
- [Module src/lib](src-lib.md)
- [Module src/capability](src-capability.md)
- [Module scripts/benchmark](scripts-benchmark.md)
- [Module src/commands](src-commands.md)

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/wiki](src-wiki.md)
- [Module src/gdgraph/treesitter](src-gdgraph-treesitter.md)
- [Module src/sync](src-sync.md)
- [Module src/lib](src-lib.md)
- [Module src/capability](src-capability.md)
- [Module src/review](src-review.md)
- [Module scripts/benchmark](scripts-benchmark.md)

## Changelog

- 1.0.1 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed. Hand-written data sections reconciled with the Reference block.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z

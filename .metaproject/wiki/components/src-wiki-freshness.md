---
Title: Module src/wiki/freshness
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/wiki/freshness` groups 12 file(s). Depends on `src/gdgraph`, `src/wiki`, `src/sync`. Exposes 8 public symbol(s)."
---
```markdown
---
Title: Module src/wiki/freshness
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/wiki/freshness` groups 12 file(s). Depends on `src/gdgraph`, `src/wiki`, `src/sync`. Exposes 8 public symbol(s)."
---
# Module src/wiki/freshness

## Overview

The `src/wiki/freshness` module evaluates whether wiki content remains current by combining:

- Graph-derived signals from code context
- Synchronization state
- Git-backed change evidence

It produces per-page freshness decisions and a Markdown report suitable for CLI output or benchmarking workflows.

## Architecture

```
run.ts ──────────────────────────────────────────────────────┐
    │                                                      │
    ▼                                                      │
page-freshness.ts                                          │
    │                                                      │
    ├── FreshnessBasis ────────────────────────────────────┤
    │                     │                               │
    ▼                     ▼                               ▼
classify-change.ts         (gdgraph)         (wiki + sync)
    │
    ▼
report.ts ──► renderMarkdown
```

### Core files

| File | Purpose |
|------|---------|
| `run.ts` | Orchestrates the freshness pipeline using `RunFreshnessInput` |
| `page-freshness.ts` | Defines `PageFreshness` and `evaluatePageFreshness` |
| `classify-change.ts` | Translates change evidence into freshness-relevant signals |
| `report.ts` | Aggregates results; `renderMarkdown` produces output |

## Key Concepts

### RunFreshnessInput

The input type passed to `runFreshness`. Describes options and data sources needed for evaluation.

### FreshnessBasis

The reference point or evidence used to judge whether a page is current. May include timestamps, graph signals, or declared staleness thresholds.

### PageFreshness

Per-page result containing the freshness decision and supporting detail.

### evaluatePageFreshness(page, basis)

Compares a page against its `FreshnessBasis` and returns a `PageFreshness` decision.

### classifyChange

Maps raw change signals (e.g., git commits, sync events) into categories the evaluator can interpret.

### renderMarkdown

Formats the aggregated report as human-readable Markdown.

### GitRunner

Injectable abstraction providing Git history and diff queries. Consumers use this interface rather than calling git directly.

### freshnessDir

Resolves the working directory used by the freshness workflow.

## Usage Flows

### Run freshness evaluation

1. Provide `RunFreshnessInput` to `runFreshness`
2. `runFreshness` retrieves page context and evidence from `src/wiki`, `src/gdgraph`, and `src/sync`
3. `evaluatePageFreshness` compares each page against its `FreshnessBasis`
4. Returns `PageFreshness` results for each page

### Generate a Markdown report

1. Collect evaluated `PageFreshness` results
2. Pass to report assembly functions
3. Call `renderMarkdown` to produce formatted output

### Use Git-based evidence

1. Inject a `GitRunner` instance
2. `classifyChange` converts git history/diff signals into freshness categories
3. These signals feed into per-page freshness decisions

## Public API

```typescript
// Entry point
runFreshness(input: RunFreshnessInput): Promise<PageFreshness[]>

// Per-page evaluation
evaluatePageFreshness(page: WikiPage, basis: FreshnessBasis): PageFreshness

// Reporting
renderMarkdown(report: FreshnessReport): string

// Utilities
freshnessDir(): string

// Abstractions
GitRunner
FreshnessBasis
PageFreshness
RunFreshnessInput
```

## Dependencies

| Module | Import Count | Role |
|--------|--------------|------|
| `src/gdgraph` | 11 | Graph-based evidence and code context |
| `src/wiki` | 5 | Page-oriented context |
| `src/sync` | 4 | Synchronization state |
| `src/gdgraph/treesitter` | 2 | Parsed source structure for graph signals |
| `src/lib` | 1 | Shared utilities |
| `src/capability` | 1 | Capability definitions |

## Consumers

- `scripts/benchmark` — 2 imports
- `src/commands` — 1 import

---

## Reference

Extracted by `keryx wiki collect`; regenerated with `--force`.

### Key files

| File | Imported by | Imports |
|------|-------------|---------|
| `run.ts` | 2 | 10 |
| `page-freshness.ts` | 6 | 3 |
| `report.ts` | 2 | 7 |
| `classify-change.ts` | 6 | 2 |
| `report.test.ts` | 0 | 5 |
| `page-freshness.test.ts` | 0 | 4 |

### Module statistics

- **Files:** 12
- **Cross-module imports:** 24
- **Public symbols:** 8

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

## Changelog

- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z
```

---
Title: Module src/health/metrics
Version: 1.0.0
Type: component
Status: accepted
Summary: `src/health/metrics` groups 8 file(s). Depends on `src/health`, `fixtures/churn-complexity`, `src/health/sources`. Exposes 3 public symbol(s).
---

# Module src/health/metrics

`src/health/metrics` is the computation layer of the health subsystem. It owns three distinct metric signals — git churn, cyclomatic complexity, and hotspot scoring — and converts raw source data into ranked findings that the parent `src/health` module can gate and report on. The module is intentionally pure and I/O-minimal: churn is the only piece that shells out to git; complexity analysis and hotspot ranking are dependency-free, deterministic functions that operate on already-loaded data.

## How it works

The module is organized around three orthogonal concerns that compose into a single enriched signal.

**`complexity.ts`** — the lowest layer: a self-contained, token-based cyclomatic complexity approximator for TypeScript/JavaScript. It strips comments and string literals, locates function bodies via brace matching (handling arrow functions, generics, and return-type annotations), then counts decision points per function while masking nested bodies so inner functions are measured in isolation. It exposes a `FileComplexity` shape (`functions`, `max`) consumed by the layers above.

**`churn.ts`** — wraps `git log --numstat` to accumulate added-plus-deleted line counts per source file over a configurable day window. It returns a `Map<string, number>` keyed by relative file path, falling back gracefully to an empty map when git is absent or the command fails.

**`hotspot.ts`** — sits atop both: it combines a churn map and a `SourceFileAnalysis` map (produced by `src/health/source-analysis`) into a ranked `FileHotspot[]`. The score for each file is `churn × complexity`; only files that are both frequently changed and complex rank high, matching the CodeScene behavioral-code-analysis model. The sort is score-descending then path-ascending for reproducibility.

**`complexity-findings.ts`** — bridges metrics into the health finding system. It calls `analyzeSourceFiles` (from `src/health`) to obtain per-function complexity arrays, then emits one P2 `Finding` per file where at least one function exceeds the configured `complexityThreshold`. The finding includes the count of over-threshold functions, the maximum complexity seen, and a suggested refactoring action.

## Key concepts

- **Cyclomatic complexity (token-based):** a count of independent execution paths in a function, approximated by counting decision keywords (`if`, `for`, `while`, `case`, `catch`, logical operators `&&`, `||`, `??`, ternary `?`) without a full AST parse.
- **Churn:** the total number of added and deleted lines in a source file over a rolling time window, derived from `git log --numstat`.
- **Hotspot score:** `churn × complexity` — a file must be both complex and frequently changed to score high. Files that are merely complex (but stable) or frequently changed (but trivial) score low by design.
- **FileHotspot:** the output shape of `rankHotspots` — `{ file, churn, complexity, score }`, sorted deterministically.
- **Finding (P2/warning):** the normalized output shape used by the broader health subsystem; `complexity-findings.ts` is the only file in this module that produces `Finding` objects.
- **SourceFileAnalysis:** an external type from `src/health/source-analysis` that carries per-function complexity arrays; hotspot and findings layers both accept it as an optional pre-computed input to avoid redundant analysis.

## Main flows

**Hotspot ranking flow:** the `src/health` coordinator calls `getChurn(cwd, windowDays)` to obtain the churn map, then calls `analyzeSourceFiles` to obtain the `SourceFileAnalysis` map, then passes both to `rankHotspots(files, churn, sourceAnalysis)`. Inside `rankHotspots`, each file is scored via `hotspotScore(churn, complexity)` where complexity is the sum of all per-function values from `fileComplexity(analysis)`. The result is a sorted `FileHotspot[]` ready for health scoring and reporting.

**Complexity findings flow:** `getComplexityFindings(cwd, sourceFiles, config, sourceAnalysis?)` optionally accepts a pre-computed `SourceFileAnalysis`; if absent, it runs `analyzeSourceFiles` itself. For each file it reads the per-function complexity array, finds the maximum and the count of functions exceeding `config.metrics.complexityThreshold`, and emits a P2 `Finding` via `makeFinding` for any file with at least one violation. These findings flow back to the parent health module for gate evaluation.

**Complexity computation flow (internal):** `computeComplexity(source)` first runs `stripStringsAndComments` to neutralize string literals and comments, then `extractFunctionBodyRanges` to locate every function body via brace matching. For each body it calls `maskNestedFunctionBodies` to blank out inner functions, then `countDecisions` on the cleaned slice to produce a per-function complexity value starting at 1 (the function itself always has at least one path).

## Code Graph

### Public API

- `getComplexityFindings` (function)
- `identity` (function)
- `f` (function)

### Key files

- `src/health/metrics/hotspot.test.ts` — imported by 0, imports 9
- `src/health/metrics/complexity-findings.ts` — imported by 2, imports 2
- `src/health/metrics/hotspot.ts` — imported by 4, imports 0
- `src/health/metrics/churn.ts` — imported by 2, imports 1
- `src/health/metrics/complexity-findings.test.ts` — imported by 0, imports 3
- `src/health/metrics/complexity.ts` — imported by 2, imports 0

### Dependencies (incoming)

- `src/health` — 9 import(s)
- `fixtures/churn-complexity` — 2 import(s)
- `src/health/sources` — 1 import(s)

### Dependents (outgoing)

- `src/health` — 7 import(s)
- `src/harness` — 1 import(s)

### Graph signals

- Files: 8
- Cross-module imports: 12

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/health](src-health.md)
- [Module src/health/sources](src-health-sources.md)
- [Module src/harness](src-harness.md)

## Changelog

- 1.0.0 — Prose enriched by gdwiki enrich workflow: Overview, How it works, Key concepts, Main flows filled from code reads of all four module core files.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

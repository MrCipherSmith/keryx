---
Title: Module src/health
Version: 1.0.0
Type: component
Status: accepted
Summary: `src/health` groups 22 file(s). Depends on `src/lib`, `src/health/metrics`, `src/health/sources`. Exposes 5 public symbol(s).
---

# Module src/health

## Overview

`src/health` is the code-quality aggregation and gate engine for keryx. It collects lint, type, test, coverage, dependency-audit, complexity, and SonarQube findings from pluggable source adapters, computes weighted health scores across project, module, component, file, and skill scopes, and evaluates a configurable pass/warn/fail gate. The module writes structured `HealthReport` artifacts to `.metaproject/data/health/` and exposes its capabilities both as a CLI-facing entry point (`runHealth`) and as a long-lived `CodeHealthService` that the MCP layer and commands consume.

## How it works

The module is organized into three cooperating layers.

### Configuration and utilities

`config.ts` and `util.ts` form the foundation.

- **`config.ts`** defines `DEFAULT_HEALTH_CONFIG` — the canonical schema‑v2 baseline with ignore patterns, per‑source modes (`auto`/`run`/`import`/`disabled`), scoring weights, and gate thresholds — and merges any project‑local override from `.metaproject/health.config.json`.
- **`util.ts`** provides cross‑cutting infrastructure: a recursive `listSourceFiles` walker (respecting extension and ignore lists), the `moduleOfFile` function that derives a module name from a file path (e.g. `src/health/run.ts` → `src/health`), glob‑pattern matching, raw log writers, and a `runCommand` wrapper around Bun's subprocess API.

### Source adapters

Source adapters in `src/health/sources` (referenced via `FINDING_ADAPTERS`) each implement a `SourceAdapter` interface with `detect`, `import`, `run`, and `parse` methods. `run.ts` drives them in parallel through a `runAdapter` helper that respects the configured mode: in `auto` mode it tries `import` first and falls back to `run` only when `NoImportError` is thrown. Raw adapter output is persisted to timestamped `.log` files under `.metaproject/data/health/raw/<source>/`, then parsed into a uniform `Finding[]` list.

Two built‑in sources — `coverage` and `complexity` — are handled inline: coverage is loaded via `getCoverage`, while complexity uses `analyzeSourceFiles` to compute per‑function cyclomatic scores without invoking any external tool.

### Metrics, scopes, and gate

The analysis layer consists of `scopes.ts`, `source-analysis.ts`, and the internal modules `gate.ts` and `scoring.ts`.

- **`source-analysis.ts`** reads each source file once, counting lines of code and computing per‑function complexity via a token‑based `computeComplexity`.
- **`scopes.ts`** (`computeMetrics`) iterates over project, module, component, file, and skill groupings, calling `healthScore` / `riskScore` with finding counts, coverage, complexity penalties, churn data, and hotspot aggregates to produce a `ScopeMetrics` record per scope. A baseline loaded from disk enables trend and regression scoring.
- **`gate.ts`** evaluates findings and scores against configured thresholds and emits a `pass`/`warn`/`fail` result.

### Service facade

`service.ts` wraps `runHealth` and the artifact‑reading helpers inside `createCodeHealthService`, a `CodeHealthService` object with operations: `run`, `status`, `gate`, `sources`, `explain`, and `updateBaseline`. The service is the interface consumed by the commands and MCP layers, allowing them to query the last report without re‑running the full pipeline.

## Key concepts

- **`HealthConfig`** — the merged configuration object that controls ignore paths, per‑source modes and required flags, metric thresholds (coverage target, complexity threshold, churn window), scoring weights (priority weights P0–P3, coverage/complexity/hotspot weights), and gate thresholds. Loaded from `DEFAULT_HEALTH_CONFIG` plus any project override.
- **`SourceAdapter`** — the plugin interface for each finding source (eslint, typescript, tests, dependencyAudit, sonarqube). Each adapter provides `detect` (is the tool present?), `import` (read existing output), `run` (execute the tool), and `parse` (convert raw text to `Finding[]`).
- **`Finding`** — a normalized quality issue: file, line, rule, message, severity (`error`/`warning`/`info`), priority (`P0`–`P3`), source, and a `scope` object that may carry a `skill` tag.
- **`SourceRunInfo`** — the per‑adapter execution summary recorded in a `HealthReport`: mode, status (`available`/`skipped`/`missing`/`configured-but-failed`/`imported`), command invoked, tool version, and finding count.
- **`ScopeMetrics`** — the computed health record for one scope (project, module, component, file, skill). Carries LOC, finding counts by severity/priority/source, coverage, churn, complexity summary, hotspot aggregate, `health_score`, `risk_score`, `trend`, and `regression_score`.
- **`ScopeSelector`** — a discriminated union (`project` | `module` | `file` | `changed`) that narrows which files and findings `runHealth` operates on.
- **`HealthReport`** — the top‑level artifact written to `.metaproject/data/health/artifacts/latest.json` and `latest.md`. Contains gate result, `sources`, `metrics` (all `ScopeMetrics`), `findings`, `hotspots`, and the git ref at run time.
- **`CodeHealthService`** — the stable API surface exposed to commands and MCP: `run`, `status`, `gate`, `sources`, `explain`, `updateBaseline`. Reads cached `latest.json` for read‑only operations so they complete without re‑running linters.
- **Baseline** — a persisted snapshot of `health_score` values per scope, written to `.metaproject/health/baselines/scores.json`. Used by `regressionScore` and `trendOf` to show whether quality is improving or degrading relative to a prior accepted state.
- **Hotspot** — a file ranked by a churn × complexity composite score (`rankHotspots`). Surfaced per scope in `ScopeMetrics.hotspot` and as a project‑level list in `HealthReport.hotspots`.

## Main flows

### Flow 1: `keryx health run` (full pipeline)

1. `runHealth` (`run.ts`) is called with a `HealthRunInput` (cwd, optional scope selector, optional source filter).
2. `loadHealthConfig` (`config.ts`) reads `.metaproject/health.config.json` and merges it over `DEFAULT_HEALTH_CONFIG`.
3. `listSourceFiles` (`util.ts`) walks the project tree, filtering by extension and ignore patterns, producing a sorted file list.
4. `analyzeSourceFiles` (`source-analysis.ts`) reads each file once, counting LOC and computing per‑function cyclomatic complexity via `computeComplexity`.
5. For each entry in `FINDING_ADAPTERS`, `runAdapter` calls `adapter.detect` then — based on configured mode — `adapter.import` or `adapter.run`, persists raw output via `writeRaw`, and calls `adapter.parse` to get `Finding[]`.
6. Coverage is fetched via `getCoverage`; complexity findings are generated inline from `source-analysis` data.
7. Skill ownership is loaded and used to tag each finding with its owning gdskill.
8. `computeMetrics` (`scopes.ts`) assembles `ScopeMetrics` for project, all modules, components, files with findings, and skill scopes.
9. `computeGate` evaluates findings, scores, and source statuses against the gate config to produce a `pass`/`warn`/`fail` result.
10. `rankHotspots` produces the project‑level hotspot list.
11. The assembled `HealthReport` is serialized to `artifacts/latest.json`, `artifacts/latest.md`, and a timestamped history entry.
12. If no baseline existed, the current scores are written as the new baseline.

### Flow 2: `keryx health gate` (fast read‑only gate check)

1. `CodeHealthService.gate` (`service.ts`) calls `readLatest`, which reads `artifacts/latest.json` from disk without running any linter.
2. If no report exists, it returns `fail` with an instruction to run first.
3. Otherwise it reads `latest.gate.status` and computes exit code: `fail` always exits 1; `warn` exits 1 only when `strictWarn` is set.
4. The reasons array from the stored gate result is returned to the caller (CLI or MCP tool).

### Flow 3: `keryx health explain <target>` (per‑scope drill‑down)

1. `CodeHealthService.explain` (`service.ts`) calls `readLatest` to obtain the stored `HealthReport`.
2. It searches `report.metrics` for a `ScopeMetrics` entry whose `key`, `name`, or key variants (`module:<name>`, `file:<path>`) match the target string.
3. It filters `report.findings` to those whose `file` or `scope.module` matches the resolved scope.
4. It returns the matching `ScopeMetrics` and its associated findings, enabling the CLI or MCP layer to surface file‑level or module‑level health detail without re‑running tools.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `runHealth` (function)
- `DEFAULT_HEALTH_CONFIG`
- `configPath` (function)
- `loadHealthConfig` (function)
- `renderHealthConfig` (function)

### Key files

- `src/health/run.ts` - imported by 2, imports 13
- `src/health/config.ts` - imported by 11, imports 2
- `src/health/util.ts` - imported by 11, imports 1
- `src/health/service.ts` - imported by 3, imports 7
- `src/health/scopes.ts` - imported by 4, imports 4
- `src/health/source-analysis.ts` - imported by 5, imports 2

### Depends on

- `src/lib` - 8 import(s)
- `src/health/metrics` - 7 import(s)
- `src/health/sources` - 5 import(s)
- `src/gdskills` - 1 import(s)

### Depended on by

- `src/health/metrics` - 9 import(s)
- `src/commands` - 7 import(s)
- `src/health/sources` - 5 import(s)
- `src/harness` - 1 import(s)
- `src/mcp` - 1 import(s)
- `src/testing` - 1 import(s)

### Graph signals

- Files: 22
- Cross-module imports: 21

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/health/metrics](src-health-metrics.md)
- [Module src/health/sources](src-health-sources.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/commands](src-commands.md)
- [Module src/harness](src-harness.md)
- [Module src/mcp](src-mcp.md)
- [Module src/testing](src-testing.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

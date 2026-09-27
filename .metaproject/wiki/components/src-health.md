---
Title: Module src/health
Version: 1.0.1
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:b89ab1952b66f31bc9e9ca68e8f50c799fd599a5a301cb71c248f3aab323fe69
Summary: `src/health` groups 22 file(s). Depends on `src/lib`, `src/health/metrics`, `src/health/sources`. Exposes 5 public symbol(s).
---
```markdown
---
Title: Module src/health
Version: 1.0.1
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:b89ab1952b66f31bc9e9ca68e8f50c799fd599a5a301cb71c248f3aab323fe69
Summary: `src/health` groups 22 file(s). Depends on `src/lib`, `src/health/metrics`, `src/health/sources`. Exposes 5 public symbol(s).
---

# Module src/health

## Overview

`src/health` is the code-quality aggregation and gate engine for keryx. It collects lint, type, test, coverage, dependency-audit, complexity, and SonarQube findings from pluggable source adapters, computes weighted health scores across project, module, component, file, and skill scopes, and evaluates a configurable pass/warn/fail gate.

The module writes structured `HealthReport` artifacts to `.metaproject/data/health/` and exposes its capabilities both as:

- **CLI entry point** (`runHealth`) for direct invocation
- **Long-lived service** (`CodeHealthService`) consumed by the MCP layer and commands

## How It Works

The module is organized into three cooperating layers.

### Configuration and Utilities

`config.ts` and `util.ts` form the foundation.

**`config.ts`** defines:
- `DEFAULT_HEALTH_CONFIG` — canonical schema-v2 baseline with ignore patterns, per-source modes (`auto`/`run`/`import`/`disabled`), scoring weights, and gate thresholds
- Merges any project-local override from `.metaproject/health.config.json`

**`util.ts`** provides cross-cutting infrastructure:
- `listSourceFiles` — recursive walker respecting extension and ignore lists
- `moduleOfFile` — derives module name from file path (e.g., `src/health/run.ts` → `src/health`)
- Glob-pattern matching
- Raw log writers
- `runCommand` — wrapper around Bun's subprocess API

### Source Adapters

Source adapters in `src/health/sources` (referenced via `FINDING_ADAPTERS`) each implement a `SourceAdapter` interface with `detect`, `import`, `run`, and `parse` methods.

**`run.ts`** drives them in parallel through a `runAdapter` helper that respects the configured mode:
- In `auto` mode: tries `import` first, falls back to `run` only when `NoImportError` is thrown

Raw adapter output is persisted to timestamped `.log` files under `.metaproject/data/health/raw/<source>/`, then parsed into a uniform `Finding[]` list.

Two built-in sources are handled inline:
- **`coverage`** — loaded via `getCoverage`
- **`complexity`** — uses `analyzeSourceFiles` to compute per-function cyclomatic scores without invoking external tools

### Metrics, Scopes, and Gate

The analysis layer consists of `scopes.ts`, `source-analysis.ts`, and internal modules `gate.ts` and `scoring.ts`.

| File | Purpose |
|------|---------|
| `source-analysis.ts` | Reads each source file once, counting LOC and computing per-function complexity via `computeComplexity` |
| `scopes.ts` | `computeMetrics` iterates over project, module, component, file, and skill groupings, calling `healthScore` / `riskScore` with finding counts, coverage, complexity penalties, churn data, and hotspot aggregates |
| `gate.ts` | Evaluates findings and scores against configured thresholds, emitting a `pass`/`warn`/`fail` result |

### Service Facade

`service.ts` wraps `runHealth` and artifact-reading helpers inside `createCodeHealthService`, a `CodeHealthService` object with operations:

- `run`
- `status`
- `gate`
- `sources`
- `explain`
- `updateBaseline`

The service reads cached `latest.json` for read-only operations so they complete without re-running the full pipeline.

## Key Concepts

### HealthConfig

The merged configuration object controlling:

- Ignore paths
- Per-source modes and required flags
- Metric thresholds (coverage target, complexity threshold, churn window)
- Scoring weights (priority weights P0–P3, coverage/complexity/hotspot weights)
- Gate thresholds

Loaded from `DEFAULT_HEALTH_CONFIG` plus any project override.

### SourceAdapter

Plugin interface for each finding source (eslint, typescript, tests, dependencyAudit, sonarqube).

| Method | Purpose |
|--------|---------|
| `detect` | Is the tool present? |
| `import` | Read existing output |
| `run` | Execute the tool |
| `parse` | Convert raw text to `Finding[]` |

### Finding

Normalized quality issue containing:

- File, line, rule, message
- Severity (`error`/`warning`/`info`)
- Priority (`P0`–`P3`)
- Source
- `scope` object with optional `skill` tag

### SourceRunInfo

Per-adapter execution summary recorded in a `HealthReport`:

- Mode
- Status (`available`/`skipped`/`missing`/`configured-but-failed`/`imported`)
- Command invoked
- Tool version
- Finding count

### ScopeMetrics

Computed health record for one scope (project, module, component, file, skill). Contains:

- LOC, finding counts by severity/priority/source
- Coverage, churn, complexity summary
- Hotspot aggregate
- `health_score`, `risk_score`, `trend`, `regression_score`

### ScopeSelector

Discriminated union (`project` | `module` | `file` | `changed`) that narrows which files and findings `runHealth` operates on.

### HealthReport

Top-level artifact written to `.metaproject/data/health/artifacts/latest.json` and `latest.md`. Contains:

- Gate result
- `sources` (all `SourceRunInfo`)
- `metrics` (all `ScopeMetrics`)
- `findings`
- `hotspots`
- Git ref at run time

### CodeHealthService

Stable API surface exposed to commands and MCP:

| Operation | Behavior |
|-----------|----------|
| `run` | Executes full health pipeline |
| `status` | Returns current health status |
| `gate` | Fast read-only gate check |
| `sources` | Lists configured sources |
| `explain` | Per-scope drill-down |
| `updateBaseline` | Updates regression baseline |

Reads cached `latest.json` for read-only operations.

### Baseline

Persisted snapshot of `health_score` values per scope, written to `.metaproject/health/baselines/scores.json`. Used by `regressionScore` and `trendOf` to show whether quality is improving or degrading relative to a prior accepted state.

### Hotspot

File ranked by a churn × complexity composite score via `rankHotspots`. Surfaced:

- Per scope in `ScopeMetrics.hotspot`
- As a project-level list in `HealthReport.hotspots`

## Main Flows

### Flow 1: Full Pipeline (`keryx health run`)

1. `runHealth` (`run.ts`) is called with a `HealthRunInput` (cwd, optional scope selector, optional source filter)
2. `loadHealthConfig` (`config.ts`) reads `.metaproject/health.config.json` and merges it over `DEFAULT_HEALTH_CONFIG`
3. `listSourceFiles` (`util.ts`) walks the project tree, filtering by extension and ignore patterns
4. `analyzeSourceFiles` (`source-analysis.ts`) reads each file, counting LOC and computing per-function cyclomatic complexity
5. For each entry in `FINDING_ADAPTERS`, `runAdapter`:
   - Calls `adapter.detect`
   - Based on configured mode, calls `adapter.import` or `adapter.run`
   - Persists raw output via `writeRaw`
   - Calls `adapter.parse` to get `Finding[]`
6. Coverage is fetched via `getCoverage`; complexity findings are generated inline
7. Skill ownership is loaded and used to tag each finding with its owning gdskill
8. `computeMetrics` (`scopes.ts`) assembles `ScopeMetrics` for all scopes
9. `computeGate` evaluates findings, scores, and source statuses against gate config
10. `rankHotspots` produces the project-level hotspot list
11. `HealthReport` is serialized to `artifacts/latest.json`, `artifacts/latest.md`, and timestamped history entry
12. If no baseline existed, current scores are written as the new baseline

### Flow 2: Fast Gate Check (`keryx health gate`)

1. `CodeHealthService.gate` (`service.ts`) calls `readLatest` to read `artifacts/latest.json` from disk
2. If no report exists, returns `fail` with instruction to run first
3. Otherwise reads `latest.gate.status` and computes exit code:
   - `fail` always exits 1
   - `warn` exits 1 only when `strictWarn` is set
4. Returns the reasons array from the stored gate result

### Flow 3: Per-Scope Drill-Down (`keryx health explain <target>`)

1. `CodeHealthService.explain` (`service.ts`) calls `readLatest` to obtain the stored `HealthReport`
2. Searches `report.metrics` for a `ScopeMetrics` entry matching the target string (`key`, `name`, or variants like `module:<name>`, `file:<path>`)
3. Filters `report.findings` to those matching the resolved scope
4. Returns the matching `ScopeMetrics` and associated findings

---

## Reference

### Public API

- `Severity`
- `Priority`
- `SourceId`
- `SourceMode`
- `SourceStatus`
- `SourceConfig`
- `HealthConfig`
- `FileHotspot`
- `FindingScope`
- `Finding`
- `RawSourceResult`
- `ScopeKind`
- `ScopeMetrics`
- `GateStatus`
- `GateResult`
- `SourceRunInfo`
- `HealthReport`
- `ScopeSelector`
- `HealthContext`
- `SourceAdapter` (interface)

### Key Files

| File | Metrics | Dependencies |
|------|---------|--------------|
| `src/health/types.ts` | 26 imports, 0 internal imports | — |
| `src/health/run.ts` | 3 imports, 16 internal imports | — |
| `src/health/service.ts` | 5 imports, 10 internal imports | — |
| `src/health/config.ts` | 11 imports, 3 internal imports | — |
| `src/health/scopes.ts` | 4 imports, 8 internal imports | — |
| `src/health/util.ts` | 11 imports, 1 internal import | — |

### Dependencies

- `src/lib` — 11 import(s)
- `src/health/metrics` — 9 import(s)
- `src/health/sources` — 5 import(s)
- `src/metrics` — 3 import(s)
- `src/gdskills` — 1 import(s)

### Dependents

- `src/health/metrics` — 14 import(s)
- `src/health/sources` — 13 import(s)
- `src/commands` — 9 import(s)
- `src/harness/tool` — 2 import(s)
- `src/eval` — 1 import(s)
- `src/mcp` — 1 import(s)

### Graph Signals

- Files: 24
- Cross-module imports: 29

---

## Related Wiki

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

- **1.0.1** — Reference refreshed from the code graph (5886c474)
- **0.1.0** — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
```

# Module src/health/sources

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/health/sources` groups 8 file(s). Depends on `src/health`, `src/testing`. Exposes 2 public symbol(s).

## Overview

`src/health/sources` is the data-collection layer of the health subsystem. It owns a set of tool adapters — one per external quality tool (ESLint, TypeScript, dependency audit, test runner, SonarQube) — each of which can detect whether the tool is present, invoke it, optionally import a pre-existing report, and parse the raw output into normalized `Finding` objects. The module's sole public surface is the `FINDING_ADAPTERS` array, which the parent `src/health` module iterates to gather findings during a health run, and the `NoImportError` sentinel used to signal that a given adapter does not support offline import.

## How it works

The module is organized around a single abstraction: the `SourceAdapter` interface (typed in `src/health/types`). Every adapter file (`eslint.ts`, `typescript.ts`, `dependency-audit.ts`, `tests.ts`, `sonarqube.ts`) exports one object that implements this interface and is collected into the `FINDING_ADAPTERS` array in `index.ts`.

Each adapter follows a three-phase lifecycle. In the **detect** phase it inspects the project to determine whether the tool is usable (`available`), present but unconfigured (`skipped`), or unreachable (`missing`). In the **run** phase it shells out to the tool binary — resolved via `resolveBin` in `helpers.ts`, which prefers a local `node_modules/.bin` installation over a global one — and returns a `RawSourceResult` carrying the tool's raw output, exit code, invoked command, and version string. In the optional **import** phase (adapters that support it, such as ESLint) the adapter can load an already-generated report file instead of running the tool live; adapters that do not support import throw `NoImportError` to signal this to the caller.

The **parse** phase is where raw tool output is converted into `Finding` objects. All adapters delegate the actual object construction to `makeFinding` in `helpers.ts`, which assigns a deterministic `id` (concatenating source, slugified rule key, normalized file path, and line number), populates a `scope` struct that includes the module derived from the file path, and records `provenance` (command, tool version, raw log path). `NoImportError` is also defined in `helpers.ts` and re-exported from `index.ts`.

The `tests` adapter is slightly more complex than the others: it can consume output from the testing module's `loadCompatibleTestingReport` service when a compatible cached report exists, allowing the health run to reuse an existing test result rather than re-running tests. This is the only cross-module import in the sources layer.

## Key concepts

- **`SourceAdapter`** — the contract each tool adapter implements: `detect`, `run`, `import`, and `parse` methods operating on a `HealthContext`.
- **`HealthContext`** — provided by the parent health module; carries the working directory (`cwd`), source file list, and scope selector that adapters use for detection and scoped test-report lookup.
- **`RawSourceResult`** — the unprocessed output of a tool invocation: raw text content, exit code, command string, tool version, and an `imported` flag distinguishing live runs from file imports.
- **`Finding`** — the normalized output of `parse`; carries severity, priority, category, a deterministic `id`, source attribution, file/line location, and a `provenance` block linking back to the raw run.
- **`NoImportError`** — a sentinel error class thrown by adapters that have no offline import format; callers use it to distinguish "import not supported" from other failures.
- **`resolveBin`** — a helper that resolves a tool binary first from the project's local `node_modules/.bin`, then from the system `PATH` via `Bun.which`.
- **`makeFinding`** — the canonical `Finding` factory; normalizes file paths, derives a stable `id`, and populates the `scope` and `provenance` fields consistently across all adapters.

## Main flows

**Live health run (e.g. ESLint):** The health orchestrator iterates `FINDING_ADAPTERS`. For the ESLint adapter it calls `detect`, which checks for a config file and a resolvable binary; if `available`, it calls `run`, which shells out to `eslint . --format json` and captures stdout. It then calls `parse`, which iterates the JSON array of file results and calls `makeFinding` once per message, mapping ESLint severity 2 to `"error"` / `"P1"` and severity 1 to `"warning"` / `"P2"`.

**Offline import (ESLint report file):** When the caller invokes `import` instead of `run`, the ESLint adapter reads `eslint-report.json` from the project root and returns it as a `RawSourceResult` with `imported: true`. The `parse` step is identical — the same JSON-to-`Finding` mapping applies regardless of whether output was live or imported.

**Test adapter with cached report:** During `detect`, the tests adapter calls `compatibleReportForHealth`, which delegates to the testing module's `loadCompatibleTestingReport` based on the `scopeSelector` kind (`changed` or `project`). If a compatible report is found, the adapter returns `"available"` and its `import` method returns the report as a `RawSourceResult`. The `parse` method then takes a different branch: it deserializes the `TestingReport` and maps each `failure` entry to a `Finding` via `makeFinding`, with `priority: "P0"` and `category: "test"`. If `run` is called instead (no cached report), it shells out to `bun test` and parses the text output line-by-line for `(fail)` markers.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `FINDING_ADAPTERS`
- `NoImportError`

### Key files

- `src/health/sources/helpers.ts` - imported by 7, imports 1
- `src/health/sources/index.ts` - imported by 2, imports 6
- `src/health/sources/dependency-audit.ts` - imported by 2, imports 2
- `src/health/sources/eslint.ts` - imported by 2, imports 2
- `src/health/sources/tests.ts` - imported by 1, imports 3
- `src/health/sources/typescript.ts` - imported by 2, imports 2

### Depends on

- `src/health` - 5 import(s)
- `src/testing` - 1 import(s)

### Depended on by

- `src/health` - 5 import(s)
- `src/health/metrics` - 1 import(s)

### Entry points

- `src/health/sources/index.ts`

### Graph signals

- Files: 8
- Cross-module imports: 6

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/health](src-health.md)
- [Module src/testing](src-testing.md)
- [Module src/health/metrics](src-health-metrics.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (Overview, How it works, Key concepts, Main flows). Status set to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

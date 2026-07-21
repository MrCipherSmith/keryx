---
Title: Module src/health/sources
Version: 1.0.0
Type: component
Status: accepted
Summary: `src/health/sources` groups 8 file(s). Depends on `src/health`, `src/testing`. Exposes 2 public symbol(s).
---

# Module src/health/sources

## Summary

`src/health/sources` groups 8 file(s). Depends on `src/health`, `src/testing`. Exposes 2 public symbol(s).

## Overview

`src/health/sources` is the data-collection layer of the health subsystem. It owns a set of tool adapters—one per external quality tool (ESLint, TypeScript, dependency audit, test runner, SonarQube). Each adapter:

- Detects whether the tool is present and configured.
- Invokes the tool or optionally imports a pre-existing report.
- Parses raw output into normalized `Finding` objects.

The module's public surface consists of:

- `FINDING_ADAPTERS` – an array that the parent `src/health` module iterates to gather findings during a health run.
- `NoImportError` – a sentinel used to signal that a given adapter does not support offline import.

## How it works

The module is organized around the `SourceAdapter` interface (typed in `src/health/types`). Every adapter file (`eslint.ts`, `typescript.ts`, `dependency-audit.ts`, `tests.ts`, `sonarqube.ts`) exports an object implementing this interface. These are collected into the `FINDING_ADAPTERS` array in `index.ts`.

Each adapter follows a three-phase lifecycle:

1. **Detect phase** – Inspects the project to determine whether the tool is usable (`available`), present but unconfigured (`skipped`), or unreachable (`missing`).
2. **Run (or Import) phase** – Either shells out to the tool binary or loads an existing report. The binary is resolved via `resolveBin` in `helpers.ts`, which prefers a local `node_modules/.bin` installation over a global one. The result is a `RawSourceResult` carrying raw output, exit code, invoked command, and version string. Adapters that support import can load a report file; those that do not throw `NoImportError`.
3. **Parse phase** – Converts raw tool output into `Finding` objects. All adapters delegate object construction to `makeFinding` in `helpers.ts`, which assigns a deterministic `id` (concatenating source, slugified rule key, normalized file path, and line number), populates a `scope` struct (including module derived from the file path), and records `provenance` (command, tool version, raw log path). `NoImportError` is also defined in `helpers.ts` and re-exported from `index.ts`.

The `tests` adapter is more complex: during detection it can query the testing module's `loadCompatibleTestingReport` service. If a compatible cached report exists, the adapter offers an import path, allowing the health run to reuse an existing test result rather than re-running tests. This is the only cross-module import in the sources layer.

## Key concepts

- **`SourceAdapter`** – The contract each tool adapter implements: `detect`, `run`, `import`, and `parse` methods operating on a `HealthContext`.
- **`HealthContext`** – Provided by the parent health module; carries the working directory (`cwd`), source file list, and scope selector that adapters use for detection and scoped test-report lookup.
- **`RawSourceResult`** – The unprocessed output of a tool invocation: raw text content, exit code, command string, tool version, and an `imported` flag distinguishing live runs from file imports.
- **`Finding`** – The normalized output of `parse`; carries severity, priority, category, a deterministic `id`, source attribution, file/line location, and a `provenance` block linking back to the raw run.
- **`NoImportError`** – A sentinel error class thrown by adapters that have no offline import format; callers use it to distinguish "import not supported" from other failures.
- **`resolveBin`** – A helper that resolves a tool binary first from the project's local `node_modules/.bin`, then from the system `PATH` via `Bun.which`.
- **`makeFinding`** – The canonical `Finding` factory; normalizes file paths, derives a stable `id`, and populates the `scope` and `provenance` fields consistently across all adapters.

## Main flows

**Live health run (e.g. ESLint):** The health orchestrator iterates `FINDING_ADAPTERS`. For the ESLint adapter:

- `detect` checks for a config file and a resolvable binary.
- If `available`, `run` shells out to `eslint . --format json` and captures stdout.
- `parse` iterates the JSON array of file results and calls `makeFinding` once per message, mapping ESLint severity 2 to `"error"` / `"P1"` and severity 1 to `"warning"` / `"P2"`.

**Offline import (ESLint report file):** When the caller invokes `import` instead of `run`:

- The ESLint adapter reads `eslint-report.json` from the project root and returns it as a `RawSourceResult` with `imported: true`.
- The `parse` step is identical—the same JSON-to-`Finding` mapping applies regardless of whether output was live or imported.

**Test adapter with cached report:** During `detect`:

- The tests adapter calls `compatibleReportForHealth`, which delegates to the testing module's `loadCompatibleTestingReport` based on the `scopeSelector` kind (`changed` or `project`).
- If a compatible report is found, the adapter returns `"available"` and its `import` method returns the report as a `RawSourceResult`.
- The `parse` method then deserializes the `TestingReport` and maps each `failure` entry to a `Finding` via `makeFinding`, with `priority: "P0"` and `category: "test"`.
- If `run` is called instead (no cached report), it shells out to `bun test` and parses the text output line-by-line for `(fail)` markers.

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

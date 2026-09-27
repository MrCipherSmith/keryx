---
Title: Module src/harness/run
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/run` groups 5 file(s). Depends on `src/harness/tool`, `src/harness`, `src/harness/provider`. Exposes 7 public symbol(s)."
---
```markdown
---
Title: Module src/harness/run
Version: 0.1.0
Type: component
Status: draft
Summary: "Provides the public run-facing layer of the harness, exposing entry points for describing, executing, and interpreting harness runs with typed interfaces for results, metrics, and unresolved risk."
---
# Module src/harness/run

## Overview

`src/harness/run` owns the run-facing layer of the harness. It provides the public contract and entry points used to describe, execute, and interpret harness runs, including dependencies, completion requirements, output shapes, metrics, and unresolved risks.

The module acts as a coordination surface between tool definitions, providers, policies, sessions, and higher-level consumers such as commands, replay, and resume. It exposes `runOffline` as the primary run function, along with typed interfaces that allow other parts of the system to consume run results without depending on internal execution details.

## How it works

- `RunDeps` represents the dependency bundle required to perform a run. It gives the run layer access to the collaborators it needs while keeping the entry point declarative.
- `runOffline` is the main public function for starting a run. It is the module's primary coordination point for assembling behavior from tools, providers, and harness primitives.
- `CompletionRequirements` describes the conditions that must be satisfied for a run to be considered complete.
- `HarnessRunOutput` and `HarnessRunOutputMetrics` describe the results produced by a run, separating qualitative output artifacts from quantitative measures.
- `UnresolvedRisk` identifies remaining risk or uncertainty surfaced during a run and carried into the result.
- `RunResult` is the top-level outcome shape consumed by callers of the run layer.
- `cli.ts` provides the command-line entry point for this module, wrapping the same run path for CLI usage.
- The main implementation lives in `src/harness/run/run.ts`, with tests covering general behavior, metaproject-level expectations, and completion requirements.

## Key concepts

- **Run dependencies**: A run does not create its own collaborators directly. Instead, it accepts a `RunDeps` bundle that supplies the tools, providers, policies, sessions, and contracts needed for execution.
- **Completion requirements**: Runs are evaluated against explicit `CompletionRequirements`. This makes completion a declared condition rather than an implicit side effect.
- **Run output**: A run produces a `HarnessRunOutput` value that carries the result artifacts exposed to callers.
- **Run metrics**: `HarnessRunOutputMetrics` captures measurable aspects of the run outcome, allowing consumers to assess performance or quality independently from raw output.
- **Unresolved risk**: When a run cannot fully satisfy its requirements or still carries uncertainty, `UnresolvedRisk` records that condition for downstream handling.
- **Run result**: `RunResult` combines the public outcome information into a single interface consumed by commands, replay, resume, and other orchestration layers.

## Main flows

### 1. Offline run through `runOffline`

1. A caller invokes `runOffline` with a `RunDeps` bundle.
2. The run layer uses the supplied dependencies to coordinate tools, providers, and harness behavior.
3. During and after execution, the run evaluates `CompletionRequirements`.
4. The run returns a `RunResult` that includes `HarnessRunOutput`, optional metrics, and any `UnresolvedRisk` entries.

### 2. CLI invocation through `cli.ts`

1. The CLI entry point in `src/harness/run/cli.ts` exposes the run module to command-line usage.
2. It prepares the same run path used by programmatic callers.
3. The resulting `RunResult` is returned to the caller or command handler for display, logging, or further processing.

### 3. Reuse by orchestration modules

1. Modules such as `src/harness`, `src/commands`, `src/harness/replay`, and `src/harness/resume` depend on this module to describe or interpret run outcomes.
2. These consumers rely on the public interfaces to avoid coupling to internal execution details.
3. Tests such as `run.metaproject.test.ts` and `run.completion-requirements.test.ts` verify expected run behavior and requirement evaluation.

---

## Reference

### Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `runOffline` | function | Primary entry point for starting a run with a `RunDeps` bundle |
| `RunResult` | interface | Top-level outcome shape combining output, metrics, and risk |
| `HarnessRunOutput` | interface | Qualitative result artifacts produced by a run |
| `HarnessRunOutputMetrics` | interface | Quantitative measures capturing run performance or quality |
| `CompletionRequirements` | interface | Declared conditions that must be satisfied for a run to complete |
| `RunDeps` | interface | Dependency bundle supplying tools, providers, policies, and sessions |
| `UnresolvedRisk` | interface | Records remaining uncertainty or unmet requirements from a run |

### Key files

| File | Purpose |
|------|---------|
| `src/harness/run/run.ts` | Main implementation (imported by 15 modules, imports 14 modules) |
| `src/harness/run/cli.ts` | Command-line entry point (imported by 1 module, imports 3 modules) |
| `src/harness/run/run.test.ts` | General behavior tests (imports 10 modules) |
| `src/harness/run/run.metaproject.test.ts` | Metaproject-level expectation tests (imports 10 modules) |
| `src/harness/run/run.completion-requirements.test.ts` | Completion requirement tests (imports 8 modules) |

### Dependencies

- [Module src/harness/tool](src-harness-tool.md) — 12 imports
- [Module src/harness](src-harness.md) — 11 imports
- [Module src/harness/provider](src-harness-provider.md) — 7 imports
- [Module src/harness/policy](src-harness-policy.md) — 6 imports
- [Module src/harness/session](src-harness-session.md) — 2 imports
- [Module src/contracts](src-contracts.md) — 1 import

### Dependents

- [Module src/harness](src-harness.md) — 3 imports
- [Module src/lib](src-lib.md) — 3 imports
- [Module src/commands](src-commands.md) — 2 imports
- [Module src/harness/replay](src-harness-replay.md) — 2 imports
- [Module src/harness/resume](src-harness-resume.md) — 2 imports

### Module metrics

- **Files**: 5
- **Cross-module imports**: 41

## Related pages

- [Wiki Index](../index.md)
- [Module src/harness/tool](src-harness-tool.md)
- [Module src/harness](src-harness.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/policy](src-harness-policy.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/contracts](src-contracts.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/replay](src-harness-replay.md)
- [Module src/harness/resume](src-harness-resume.md)

## Changelog

- **0.1.0** — Initial draft generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```

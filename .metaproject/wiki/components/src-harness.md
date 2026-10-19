---
Title: Module src/harness
Version: 1.0.4
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:addfd1ceb6a0fe385058f24b228b593d8ea5499f3ed59168f1e16c8aeea60da5
Summary: `src/harness` provides a framework for spawning and managing test harness subprocesses. Exposes 8 public symbols. Depends on `src/harness/external`, `src/harness/child`, `src/harness/session`, `src/harness/provider`, `src/harness/run`, `src/harness/tool`.
---

# Module src/harness

## Summary

`src/harness` provides a framework for spawning and managing test harness subprocesses. It exposes interfaces for configuration, resource budgets, network policy, and RPC communication between the host and harness processes. The module is a foundational dependency for `src/commands`, `src/tui`, `src/lib`, and the harness sub-modules (`replay`, `resume`).

## Overview

`src/harness` defines the core interfaces and factories for running external processes under test. Rather than executing tests in-process, the harness model isolates test execution into a child process, communicating via RPC. This pattern provides:

- **Isolation**: Test failures cannot crash or corrupt the host process.
- **Resource control**: Configurable budgets for time, memory, and other resources.
- **Policy enforcement**: Network access and other system-level policies can be applied to the child process.
- **Replay/resume support**: A separate harness process can be paused, persisted, and resumed.

The module does not contain the runner logic itself; that lives in `src/harness/run`. This module provides the shared types, configuration schema, and RPC primitives.

## Key interfaces

### HarnessConfig

Top-level configuration for a harness invocation. Controls how the child process is spawned and what capabilities it receives.

### HarnessLimits

Defines resource limits for a harness run, such as maximum execution time, memory ceiling, or disk usage bounds.

### HarnessNetworkPolicy

Specifies which network operations the harness subprocess may perform. Used to restrict outbound connections, DNS resolution, or socket creation during test execution.

### HarnessRole

Enumerates the operational mode of the harness (e.g., `runner`, `replay`, `resume`). The role determines which subsystems are initialized in the child process.

### HarnessTransport

Identifies the IPC mechanism used for RPC communication between host and harness (e.g., `stdio`, `unix-socket`).

### HarnessBudget

Tracks and enforces consumption of allocated resources across a harness lifecycle. May be reset or queried mid-execution.

### HarnessScope

Defines the visible namespace available to the harness process — which modules, files, or environment variables are accessible.

### HarnessRunInput

The input payload passed to the harness when initiating a run — typically includes the test target, configuration overrides, and any context needed by the child process.

## Architecture

```
Host process
├── src/harness/config.ts     # Loads and validates HarnessConfig
├── src/harness/types.ts      # Shared type definitions
├── src/harness/run-external-factory.ts  # Spawns harness subprocesses
└── src/harness/rpc.ts        # RPC client for host→harness communication

Harness subprocess (child)
├── Receives HarnessRunInput
├── Initializes based on HarnessRole
├── Enforces HarnessLimits and HarnessNetworkPolicy
├── Reports progress via HarnessTransport
└── Exits with structured result
```

## How it works

**Configuration loading** (`config.ts`)  
`config.ts` provides functions to build a `HarnessConfig` from environment variables, CLI flags, or programmatic input. It is imported by 17 other modules, making it the primary configuration entry point for any harness-based operation.

**Type definitions** (`types.ts`)  
All core interfaces (`HarnessLimits`, `HarnessNetworkPolicy`, `HarnessConfig`, `HarnessRole`, `HarnessTransport`, `HarnessBudget`, `HarnessScope`, `HarnessRunInput`) are exported from `types.ts`. No other module re-exports these types; consumers import directly from `src/harness/types`.

**Subprocess spawning** (`run-external-factory.ts`)  
This factory creates the child process using the configuration provided. It is imported by 4 modules and depends on 11 modules, reflecting its role as the integration hub that wires together session management, tool execution, provider resolution, and external process handling. Tests in `run-external-factory.test.ts` validate the spawning behavior.

**RPC communication** (`rpc.ts`)  
`rpc.ts` implements the host-side RPC client. It is imported by 2 modules and depends on 3 modules. Tests in `rpc.test.ts` (imported by 0 production modules) verify RPC serialization, timeouts, and error propagation.

## Dependencies

`src/harness` is composed of several sub-modules:

| Sub-module | Import count | Role |
|------------|--------------|------|
| `src/harness/external` | 11 | Manages external process lifecycle |
| `src/harness/child` | 4 | Low-level child process utilities |
| `src/harness/session` | 3 | Tracks harness session state |
| `src/harness/provider` | 3 | Provides runtime capabilities to harness |
| `src/harness/run` | 3 | Runner logic (also depends back on this module) |
| `src/harness/tool` | 3 | Tool invocation within harness context |

## Dependents

Other modules consume `src/harness` to spawn and control harness processes:

| Consumer | Import count |
|----------|--------------|
| `src/harness/run` | 11 |
| `src/commands` | 7 |
| `src/harness/replay` | 4 |
| `src/harness/resume` | 4 |
| `src/lib` | 4 |
| `src/tui` | 2 |

## Graph signals

- Files in module: 13
- Cross-module imports: 40

---

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/external](src-harness-external.md)
- [Module src/commands](src-commands.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/lib/oauth](src-lib-oauth.md)
- [Module src/harness/routing](src-harness-routing.md)
- [Module src/harness/run](src-harness-run.md)
- [Module src/tui](src-tui.md)

<!-- keryx:reference:begin v=1 hash=d38af6d45f0917c02deaed7a77cff3b09bdc402c59ee93e04dbfd003ea2be02f -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `HarnessLimits`
- `HarnessNetworkPolicy`
- `HarnessConfig`
- `HarnessRole`
- `HarnessTransport`
- `HarnessBudget`
- `HarnessScope`
- `HarnessRunInput`

### Key files

- `src/harness/config.ts` - imported by 21, imports 0
- `src/harness/types.ts` - imported by 21, imports 0
- `src/harness/run-external-factory.ts` - imported by 6, imports 11
- `src/harness/provider-catalog.ts` - imported by 6, imports 7
- `src/harness/rpc.test.ts` - imported by 0, imports 12
- `src/harness/provider-catalog-cache.ts` - imported by 5, imports 3

### Depends on

- `src/harness/external` - 8 import(s)
- `src/commands` - 4 import(s)
- `src/lib` - 3 import(s)
- `src/harness/child` - 2 import(s)
- `src/lib/oauth` - 1 import(s)
- `src/harness/routing` - 1 import(s)

### Depended on by

- `src/commands` - 8 import(s)
- `src/harness/run` - 5 import(s)
- `src/tui` - 4 import(s)
- `src/harness/resume` - 2 import(s)
- `src/lib` - 2 import(s)

### Dependency basis

- Production imports only: 56 import(s) from test file(s) (e.g. `src/commands/agents-external.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 17
- Cross-module imports: 23
<!-- keryx:reference:end -->

## Changelog

- 1.0.4 - Reference and Related Wiki added from the code graph (the page predated them).
- 1.0.3 - Unwrapped the page from a ```markdown fence an earlier enrich wrote it into (flow 367); the duplicate front matter inside it removed, its enriched Summary kept. No prose changed.
- 1.0.2 - Reconciled prose with actual code graph; documented HarnessConfig, types, run-external-factory, and RPC architecture.
- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 1.0.0 - Prose enriched by gdwiki enrich workflow.
- 0.1.0 - Generated by `keryx wiki collect`.

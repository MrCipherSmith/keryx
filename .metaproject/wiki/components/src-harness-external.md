---
Title: Module src/harness/external
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/external` groups 21 file(s). Depends on `src/harness/external/codec`, `src/mcp-client`, `src/harness/monitor`. Exposes 13 public symbol(s)."
---
```markdown
---
Title: Module src/harness/external
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/harness/external` groups 21 file(s). Depends on `src/harness/external/codec`, `src/mcp-client`, `src/harness/monitor`. Exposes 13 public symbol(s)."
---

# Module src/harness/external

## Overview

`src/harness/external` is the harness-facing boundary for running, supervising, and reporting on external agents or child processes. It groups the typed contracts and orchestration helpers used to start external work, interpret its events, and return structured completion outcomes.

The module is primarily used by `src/tui`, `src/harness`, `src/commands`, and smoke-test entry points that need a consistent interface for external execution rather than directly handling process, codec, monitor, or MCP-client details.

## Architecture

The module separates its concerns into three layers:

| Layer | Purpose | Key Files |
|-------|---------|-----------|
| **Contract** | Defines the public vocabulary for external work | `types.ts` |
| **Orchestration** | Connects run inputs to execution paths | `runtime.ts`, `dispatch.ts`, `registry.ts` |
| **Supervision** | Observes external children and manages lifecycle | `supervise.ts`, `supervise-mcp.ts` |

- **Contract layer**: `src/harness/external/types.ts` defines the public vocabulary for external agents, run inputs, events, codecs, and outcomes. This file is the most widely reused part of the module.
- **Orchestration layer**: `runtime.ts` and `dispatch.ts` connect run inputs to the appropriate external execution path. `registry.ts` provides registration or lookup semantics for external agent definitions.
- **Supervision layer**: `supervise.ts` and `supervise-mcp.ts` observe external children and manage lifecycle concerns. The MCP-specific path depends on `src/mcp-client`, while general supervision coordinates monitor and child-process related abstractions.
- **Codec boundary**: the dependency on `src/harness/external/codec` indicates that external representations are translated to and from typed harness objects.

The public `runExternalChild` function is the main execution entry point. It accepts a `RunExternalChildInput` and a set of `RunExternalChildDeps`, allowing callers to inject the dependencies needed for an external run.

## Key Concepts

- **External agent entry**  
  `ExternalAgentEntry` represents a describable external agent or integration that can be registered or invoked through the harness.

- **Run input**  
  `ExternalRunInput` describes the parameters needed to start an external child or agent run.

- **Sandbox boundary**  
  `ExternalSandbox` names the execution boundary or isolation concept associated with external work.

- **External events**  
  `ExternalEvent` represents observable activity emitted during an external run. `TERMINAL_EVENT_KINDS` and `isTerminalEvent` identify events that mark completion or finalization.

- **Outcomes and status**  
  `ProcessOutcome`, `ExternalChildOutcome`, and `ExternalCompletionStatus` provide typed result representations for completed external work.

- **Codec abstraction**  
  `ExternalAgentCodec` describes translation between harness-side objects and external representations.

- **Dependency injection**  
  `RunExternalChildDeps` lets callers provide the runtime dependencies required by `runExternalChild`, keeping the module decoupled from concrete process or client implementations.

## Usage Flows

### Run an external child

1. A caller constructs a `RunExternalChildInput` describing the external child to start.
2. The caller supplies `RunExternalChildDeps` with the dependencies required for execution.
3. `runExternalChild` dispatches the run through the module's runtime or supervisor abstractions.
4. The result is returned as a typed outcome, such as `ProcessOutcome` or `ExternalChildOutcome`.

### Observe external execution

1. While an external child runs, it may emit `ExternalEvent` values.
2. Consumers can inspect events for progress or errors.
3. `isTerminalEvent` and `TERMINAL_EVENT_KINDS` are used to recognize when an event represents a final state.
4. Completion is then mapped to an appropriate `ExternalCompletionStatus` or outcome object.

### Supervise an MCP-based external interface

1. `supervise-mcp.ts` provides supervision for external interfaces connected through `src/mcp-client`.
2. MCP client interactions are combined with codec translation through `src/harness/external/codec`.
3. Monitor-related dependencies from `src/harness/monitor` can be used to observe lifecycle activity.
4. The final external result is normalized into the module's public outcome types.

---

## Reference

### Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `ExternalSandbox` | type | Execution boundary or isolation concept |
| `ExternalAgentEntry` | interface | Describable external agent or integration |
| `ExternalRunInput` | interface | Parameters to start an external run |
| `ExternalEvent` | type | Observable activity during an external run |
| `TERMINAL_EVENT_KINDS` | constant | Event kinds that mark completion |
| `isTerminalEvent` | function | Predicate to identify terminal events |
| `ProcessOutcome` | interface | Typed result for completed processes |
| `ExternalAgentCodec` | interface | Translation between harness and external representations |
| `ExternalCompletionStatus` | type | Normalized completion state |
| `ExternalChildOutcome` | interface | Result of an external child run |
| `RunExternalChildInput` | interface | Input for starting an external child |
| `RunExternalChildDeps` | interface | Injectable runtime dependencies |
| `runExternalChild` | function | Main execution entry point |

### File Inventory

| File | Imports | Reused By |
|------|---------|-----------|
| `types.ts` | 0 | 26 |
| `runtime.ts` | 10 | 4 |
| `supervise.ts` | 2 | 11 |
| `registry.ts` | 1 | 10 |
| `supervise-mcp.ts` | 9 | 2 |
| `dispatch.ts` | 2 | 4 |

### Module Dependencies

- [src/harness/external/codec](src-harness-external-codec.md) — codec boundary (6 imports)
- [src/mcp-client](src-mcp-client.md) — MCP client integration (5 imports)
- [src/harness/monitor](src-harness-monitor.md) — lifecycle observation (2 imports)
- [src/harness/child](src-harness-child.md) — child process abstractions (2 imports)
- [src/capability](src-capability.md) — capability definitions (2 imports)
- [src/commands](src-commands.md) — command layer (2 imports)

### Module Consumers

- [src/tui](src-tui.md) — 14 imports
- [src/harness](src-harness.md) — 11 imports
- [src/harness/external/codec](src-harness-external-codec.md) — 5 imports
- [src/commands](src-commands.md) — 4 imports
- `scripts/smoke` — 3 imports
- [src/mcp-servers](src-mcp-servers.md) — 2 imports

---

## Related Pages

- [Wiki Index](../index.md)
- [Module src/harness/external/codec](src-harness-external-codec.md)
- [Module src/mcp-client](src-mcp-client.md)
- [Module src/harness/monitor](src-harness-monitor.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/capability](src-capability.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/harness](src-harness.md)

## Changelog

- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```

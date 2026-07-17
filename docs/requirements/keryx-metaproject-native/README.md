# Keryx Metaproject-Native Harness Requirements Package
Version: 0.1.0

## Status

`draft` — requirements gathering. This package specifies making the keryx harness
work DIRECTLY with the metaproject layer (graph, wiki, memory, context, and the
Task Manager) through a single typed port and schema-driven tools, rather than the
current mix of subprocess wrappers and hardcoded MCP adapters. No new runtime is
implemented yet; the harness, agent shell (`src/commands/agent.ts`), `src/mcp/`
tool/resource surface, and the metaproject module facades already exist and are
cited as the foundation.

## Purpose

keryx today has two disjoint ways to reach the metaproject layer: (1) the agent
shell wraps `keryx` CLI subprocesses (`src/harness/tool/builtin/metaproject-tools.ts`),
and (2) `src/mcp/tools.ts` exposes ~21 read-only adapters over service facades to
external MCP clients. The harness core itself has NO in-process, typed access to
graph/wiki/memory/tasks. This package defines a **`MetaprojectPort`** — a single,
schema-backed contract for metaproject access — so the harness, the interactive
agent, and the MCP server all consume ONE source of truth, and so the Task Manager
becomes a universal, runtime-agnostic surface any agent can drive. The goal is a
"universal keryx": the harness natively speaks the metaproject layer.

## Document Index

- [PRD](prd.md) — problem, users, requirements, success criteria, risks, and recommendation.
- [Specification](specification.md) — the `MetaprojectPort` and Task Manager port contracts, the unified tool surface (harness + agent + MCP), CLI/command surface, data contracts, integrations, and acceptance criteria.
- [JSON Schemas](schemas/) — machine-readable contracts for the metaproject operations and results.

## Scope

- A typed **`MetaprojectPort`** contract for graph, wiki, memory, and context
  operations, content-returning (not hashed receipts), injectable into the harness
  `RunDeps` and the agent shell.
- A **universal Task Manager port** (building on TM-01 `ManagedFlowPort`) with a
  stable schema so ANY runtime reads flow state and drives status transitions
  without editing `flow.json` by hand (preserving the D-02 invariant).
- **Schema-driven, dedicated operations** for graph/wiki/memory/tasks exposed
  uniformly to the harness (in-process tools), the interactive agent, and MCP
  clients from a single tool definition source.
- JSON schemas for every operation's input and result.

## Non-Goals

- No change to which module OWNS graph/wiki/memory/tasks data — the existing
  module facades remain the implementation; this adds a port, not a rewrite.
- No mutation of Task Manager state by the harness beyond the sanctioned port
  transitions — the D-02 invariant ("the harness never writes `flow.json` by hand")
  is preserved.
- No replacement of the existing `src/mcp/` server; it is refactored to source its
  tools from the unified surface, not re-implemented.
- No new production dependency for the port/schema layer.

## Related Modules

- `src/harness/run/run.ts` — the `runOffline` run-loop and `RunDeps` (the injection point for `MetaprojectPort`).
- `src/harness/tool/` — `ToolRegistry`, `ToolDefinition`, `ToolExecutorPort`, risk/policy model.
- `src/commands/agent.ts`, `src/commands/shell.ts`, `src/harness/tool/builtin/` — the interactive agent driver and its metaproject tools.
- `src/mcp/` — `server.ts`, `tools.ts` (21 facade adapters), `resources.ts` (`metaproject://` resources).
- `src/gdgraph/`, wiki (`src/wiki/`), `src/memory/`, flow/Task Manager (`src/flow/`) — the metaproject module facades that back the port.
- `docs/decisions/keryx-harness/TM-01-task-manager-evolution.md` — the `ManagedFlowPort` / D-02 basis for the universal Task Manager.
- `docs/decisions/keryx-harness/SA-01-interactive-shell-agent-mode.md` — the agent-mode RFC this package extends.

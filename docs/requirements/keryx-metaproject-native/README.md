# Keryx Metaproject-Native Harness Requirements Package
Version: 0.2.0

## Status

`implemented (Phases 1–3; Phase 4 + harness-core in-process wiring pending)`.
This package specifies making the keryx harness work DIRECTLY with the
metaproject layer (graph, wiki, memory, context, and the Task Manager) through a
single typed port and schema-driven tools, rather than the prior mix of
subprocess wrappers and hardcoded MCP adapters. **Phases 1–3 have shipped**;
Phase 4 (policy-context enrichment) and the harness-core `RunDeps.metaprojectPort`
seam (integration S1) are still open.

Runtime evidence (Phases 1–3):

- **Phase 1 — port + reference adapter (MP-1, MP-2):** `src/harness/tool/metaproject-port.ts`
  defines the typed `MetaprojectPort` interface (`searchCode`, `graphAffected`,
  `graphQuery`, `memorySearch`, `readWiki`, `describeContext` + additive optional
  operations `graphPath`, `testRelated`, `healthStatus`, `graphSymbol`, `repomap`,
  `wikiAsk` from flows 043/044). `src/harness/tool/metaproject-adapter.ts`
  (`createMetaprojectAdapter(cwd, deps?)`) delegates to the existing
  `createGdgraphService` / `createMemoryService` facades (flow 037).
- **Phase 2 — single-source operation descriptors (MP-3):**
  `src/harness/tool/metaproject-operations.ts` exports `METAPROJECT_OPERATIONS`,
  `toInteractiveTools`, `toToolDefinitions`, and shared formatters (flow 038).
- **Phase 3 — universal Task Manager schema (MP-4):** `src/flow/schema.ts`
  `flowStateSchema()` is the runtime source of truth and is asserted
  byte-consistent with this package's
  `schemas/flow-state.schema.json` by `src/flow/schema.test.ts`; the
  `keryx flow schema [--out <path>]` CLI subcommand is implemented at
  `src/commands/flow.ts:88`.
- **Projections (one definition, three consumers):**
  - Agent shell: `src/harness/tool/builtin/metaproject-tools.ts`
    `builtinMetaprojectTools(root, runner, port?)` — called from
    `src/commands/shell.ts:1085` with `createMetaprojectAdapter(cwd)`; the legacy
    subprocess path (`makeKeryxRunner`, `Bun.spawn(["keryx", ...])`) is demoted
    to a fallback used only when `port` is omitted.
  - MCP: `src/mcp/metaproject-tools.ts` `toMcpTools()` (flow 040), spread into
    `buildToolRegistry()` at `src/mcp/tools.ts:80`. All unified entries are
    read-only (`mutating: false`), preserving the M-10 read-only contract.

Still pending (Phase 4 + retirement):

- **S1 outstanding:** `metaprojectPort?: MetaprojectPort` is NOT yet a field of
  `RunDeps` (`src/harness/run/run.ts:101-109`). The agent shell consumes the port
  in-process, but the harness core itself does not yet.
- **Phase 4 (MP-6) policy-context enrichment** — `PolicyContext.metaprojectContext`
  does not exist.
- **Legacy MCP adapter retirement** — old hardcoded adapters in
  `src/mcp/tools.ts:81+` remain registered (deduped by name with the unified
  surface) pending a separate retirement pass.
- **Subprocess wrapper retirement** — `metaproject-tools.ts` still ships the
  subprocess fallback path; `searchCode` degrades to it because gdctx has no
  in-process API yet.
- **Minor schema drift:** `schemas/memory-search-result.schema.json` defines
  filter keys `module/entity/status/class/asOf`; the TS `MemorySearchFilters`
  only has `module?/status?` (spec ahead of implementation).

This package's schemas are complete and consistent
(`metaproject-operation.schema.json`, `graph-affected-result.schema.json`,
`memory-search-result.schema.json`, `flow-state.schema.json` v1+v2 additive,
Draft-07). The D-02 invariant is preserved (no runtime hand-edits `flow.json`).

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

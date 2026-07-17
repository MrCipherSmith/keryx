# Keryx Metaproject-Native Harness PRD
Version: 0.1.0

## Problem

The keryx harness and the metaproject layer (graph, wiki, memory, context,
health, testing, Task Manager) evolved on separate tracks and reach each other
through three inconsistent, partially-overlapping paths:

1. **Subprocess wrappers** — the interactive agent's metaproject tools
   (`src/harness/tool/builtin/metaproject-tools.ts`, flow 035) spawn `keryx ctx rg`
   / `keryx gdgraph affected` / `keryx memory search` as external processes with
   bounded (20 KB) string output — high latency, no structured navigation, coarse
   error handling.
2. **Hardcoded MCP adapters** — `src/mcp/tools.ts` exposes ~21 read-only adapters
   over service facades and `src/mcp/resources.ts` exposes `metaproject://` URIs,
   but ONLY to external MCP clients; the harness core cannot use them.
3. **No in-process port** — `runOffline`'s `RunDeps` has `provider`,
   `toolRegistry`, `toolExecutor`, and `policyProfile`, but NOTHING for metaproject
   access. The harness cannot read the graph/wiki/memory to inform tools or policy.

Meanwhile the **Task Manager** (`createFlowService`, `ManagedFlowPort`) is
TypeScript-only: its `FlowState`/`FlowTask` model and the harness bridge exist, but
there is no exported JSON Schema or language-agnostic wire contract, so only the
`keryx` CLI can drive flows. keryx is not yet "universal": another runtime cannot
natively speak the metaproject layer or the Task Manager.

## Goal

Make the harness speak the metaproject layer NATIVELY through a single typed,
schema-backed **`MetaprojectPort`**, and make the **Task Manager universal** by
publishing its schema and a runtime-agnostic port — so the harness, the interactive
agent, and MCP clients all consume ONE source of truth, with in-process access
where a service facade exists and a graceful fallback where it does not.

## Users

- **The keryx interactive agent** (`keryx shell --agent`) — needs structured,
  low-latency metaproject data instead of truncated subprocess text.
- **The harness run-loop** (`runOffline`) — needs in-process metaproject access to
  compose tools and (optionally) enrich policy decisions.
- **External agent runtimes / MCP clients** (Claude, Cursor, opencode) — need one
  consistent, schema-described tool + resource surface and a drivable Task Manager.
- **Metaproject maintainers** — need one place to define a metaproject operation and
  have it appear across harness, agent, and MCP.

## Requirements

### MP-1 — MetaprojectPort contract
A typed `MetaprojectPort` interface (with matching JSON Schemas) for read
operations over graph, wiki, memory, and context: e.g. `searchCode`,
`graphAffected`, `graphQuery`, `memorySearch`, `readWiki`, `describeContext`. It is
CONTENT-returning (not hashed receipts), deterministic (no `Date.now`/`Math.random`),
and side-effect-free.

### MP-2 — Reference adapter over existing facades
A reference `MetaprojectPort` implementation that delegates to the EXISTING module
services — `createGdgraphService()` (`src/gdgraph/service.ts`), `createMemoryService()`
(`src/memory/service.ts`), plus health/testing where relevant — and, for CLI-only
modules (gdctx, gdwiki), reads their published data artifacts / falls back to a
bounded CLI call. No module ownership changes.

### MP-3 — Unified, schema-driven tool surface
ONE tool-definition source (name + `inputSchema` + `outputSchema` + `risk`) per
metaproject operation, consumed by (a) the harness `ToolRegistry`, (b) the agent
`InteractiveTool` set (replacing the subprocess wrappers), and (c) the `src/mcp/`
server (replacing/deduping the hardcoded adapters). A new operation is defined once.

### MP-4 — Universal Task Manager surface
Publish `FlowState` and `FlowTask` (v1 + v2) as JSON Schema
(`.metaproject/flows/flow.schema.json`) and specify the `ManagedFlowPort` /
`FlowService` as a language-agnostic contract, so ANY runtime can (a) read flow
state, (b) drive status transitions and task/AC updates through the port, and
(c) validate `flow.json` — WITHOUT hand-editing it. The D-02 invariant (the harness
never writes `flow.json`) is preserved: writes go through `FlowService` only.

### MP-5 — Dedicated commands / schemas for graph, wiki, tasks
Ensure each metaproject domain has explicit, documented operations and machine-
readable schemas surfaced through MP-3 (graph query/affected/path, wiki read/ask/
backlinks, memory search, flow read/transition), so the agent and external runtimes
use named, validated operations rather than ad-hoc CLI strings.

### MP-6 — Policy-context enrichment (Phase 2, optional)
Allow the harness policy engine to consult `MetaprojectPort` before a decision
(e.g. blast-radius from `graphAffected`, prior mistakes from `memorySearch`) so
policy can be context-aware, not risk-only. Additive to `PolicyContext`; never
weakens the default-deny posture.

## Success Criteria

- A `MetaprojectPort` + JSON schemas exist; the interactive agent's metaproject
  tools call it in-process (no subprocess) and return structured results.
- A single tool-definition source feeds harness + agent + MCP; adding one operation
  surfaces it in all three without duplication.
- `flow.schema.json` validates existing v1 and v2 `flow.json` files; a documented,
  language-agnostic Task Manager port lets a non-keryx runtime read a flow and drive
  a status transition without editing `flow.json`.
- `tsc` clean; the full `bun test` suite stays green at or above baseline; the whole
  suite remains offline/deterministic; no new production dependency for the port.
- No regression to the D-02 invariant, the existing MCP `M-10` read-only posture, or
  the agent-mode approval gates.

## Risks

- **Scope creep / big-bang refactor** — mitigated by phasing (port → adapter →
  unify tools → TM schema → policy) and keeping module facades untouched.
- **Determinism** — some services touch the filesystem/embeddings; the port must
  keep the harness core deterministic (inject the port; keep `Date.now`/`Math.random`
  out of the core).
- **CLI-only modules (gdctx/gdwiki)** — no in-process API; the adapter reads their
  data artifacts or makes a bounded, argv-safe CLI call (documented as such).
- **Task Manager universality vs. D-02** — external runtimes must drive transitions
  through the port; direct `flow.json` writes remain forbidden. The schema is for
  reading/validation, not a license to hand-edit.
- **MCP consolidation** — deduping the 21 hardcoded adapters against the unified
  surface must preserve the current read-only (`M-10`) guarantees and URIs.

## Recommendation

Adopt the **port-and-adapter** pattern the harness already uses (ProviderPort,
ToolExecutorPort) for the metaproject layer, delivered in phases:

- **Phase 1 — `MetaprojectPort` + reference adapter** over `createGdgraphService`
  and `createMemoryService`, injected into the agent shell; the agent's metaproject
  tools call it in-process (replacing subprocess wrappers). Ship the JSON schemas.
- **Phase 2 — Unified tool surface**: one tool-definition source feeding the harness
  `ToolRegistry`, the agent, and the `src/mcp/` server; retire duplication.
- **Phase 3 — Universal Task Manager**: export `flow.schema.json`, specify the
  `ManagedFlowPort`/`FlowService` wire contract + the gate→disposition decision
  table, and document how a non-keryx runtime drives flows (D-02 preserved).
- **Phase 4 — Policy-context enrichment** (optional): consult the port in policy
  decisions.

Each phase is an independent flow with frozen acceptance criteria, mirroring the
SA-01 Flow A/B/C delivery model.

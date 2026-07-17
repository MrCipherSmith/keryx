# Keryx Metaproject-Native Harness Specification
Version: 0.1.0

## Identity

| Field | Value |
|---|---|
| Name | `keryx-metaproject-native` |
| Kind | standard capability (harness ↔ metaproject integration) |
| Status | draft (no runtime implemented; foundation modules cited) |
| Owner | Keryx core / Metaproject maintainers |
| State owner | Metaproject module facades (`src/gdgraph`, `src/memory`, wiki, `src/flow`) — unchanged |
| Runtime owner | Keryx harness core (`src/harness`) + agent shell (`src/commands/agent.ts`) + `src/mcp` |
| Default mode | disabled until implemented; opt-in per phase |
| Primary transport | in-process port (harness/agent) + MCP tools/resources (external runtimes) |
| Canonical contracts | [schemas/](schemas/) |

## Design Principles

1. **Port-and-adapter, not rewrite.** Follow the harness's existing `ProviderPort`
   / `ToolExecutorPort` pattern: define `MetaprojectPort`, inject it, compose tools
   and policy on top. The metaproject module facades remain the implementation and
   sole owners of their data.
2. **One definition, three consumers.** A metaproject operation is defined ONCE (a
   name + input schema + output schema + risk + module) and surfaces in the harness
   `ToolRegistry`, the agent `InteractiveTool` set, and the `src/mcp` server.
3. **Content in the port, receipts in the harness.** `MetaprojectPort` returns
   structured CONTENT (the durable `ToolExecutorPort` receipt/hash model is a
   separate concern applied downstream).
4. **Determinism preserved.** The harness core uses only injected `clock`/`idSeq`;
   the port is injected so filesystem/embedding access never leaks non-determinism
   into the core.
5. **Read-first, gated-write.** Metaproject reads are risk `read`; the only writes
   are Task Manager transitions through `FlowService` (never hand-edited
   `flow.json`) and command execution through the existing approval gate.
6. **Universal by schema.** Anything an external runtime must understand
   (metaproject operations, flow state) is published as JSON Schema, not only TS.

## Architecture Position

```text
                         ┌─────────────────────────────┐
   external runtime ───▶ │  src/mcp  (tools + resources)│──┐
   (Claude/Cursor/…)     └─────────────────────────────┘  │
                         ┌─────────────────────────────┐  │   one tool-definition
   keryx shell --agent ─▶│ agent InteractiveTool set    │──┤   source (MP-3)
                         └─────────────────────────────┘  │
                         ┌─────────────────────────────┐  │
   harness runOffline ──▶│ ToolRegistry / RunDeps       │──┘
                         └──────────────┬──────────────┘
                                        ▼
                            ┌───────────────────────┐
                            │   MetaprojectPort      │  (MP-1, content-returning)
                            └───────────┬───────────┘
                                        ▼  reference adapter (MP-2)
       createGdgraphService · createMemoryService · wiki/ctx artifacts · health
                                        │
                            ┌───────────▼───────────┐
                            │  FlowService / ManagedFlowPort │  (MP-4, D-02 preserved)
                            └───────────────────────┘
```

The four integration seams (from the harness map): **(S1)** `MetaprojectPort` in
`RunDeps`; **(S2)** native agent tool factory replacing subprocess wrappers;
**(S3)** MCP tools/resources sourced from the unified surface; **(S4)** optional
policy-context enrichment.

## MetaprojectPort (MP-1)

A content-returning, deterministic read port. Reference shape (TypeScript; each
method's input/result also has a JSON Schema under `schemas/`):

```typescript
export interface MetaprojectPort {
  searchCode(input: { pattern: string; path?: string }): Promise<SearchCodeResult>;
  graphAffected(input: { target: string; depth?: number; ranked?: boolean }): Promise<GraphAffectedResult>;
  graphQuery(input: { query: "cycles" | "orphans" }): Promise<GraphQueryResult>;
  memorySearch(input: { query: string; module?: string; status?: string; limit?: number }): Promise<MemorySearchResult>;
  readWiki(input: { path: string }): Promise<WikiPageResult>;
  describeContext(): Promise<ContextSummaryResult>;
}
```

Backing (MP-2), per the module catalog:

| Operation | Backing facade | In-process? |
|---|---|---|
| `graphAffected` / `graphQuery` | `createGdgraphService()` (`affected`, `query`, `loadGraph`, pure `computeAffected`) | ✅ in-process |
| `memorySearch` | `createMemoryService()` (`search`, deterministic ranked) | ✅ in-process |
| `searchCode` | `keryx ctx rg` artifact / bounded argv CLI (gdctx is CLI-only) | fallback |
| `readWiki` | `.metaproject/wiki/**` file read (gdwiki is file-based) | ✅ file read |
| `describeContext` | gdgraph `context` + wiki index summary | mixed |

## Unified Tool Surface (MP-3)

A single descriptor per operation, validated against
[`schemas/metaproject-operation.schema.json`](schemas/metaproject-operation.schema.json):

```jsonc
{
  "name": "graph_affected",
  "module": "gdgraph",
  "description": "Blast radius (transitive dependents) of a file or symbol.",
  "risk": "read",
  "inputSchema":  { "type": "object", "properties": { "target": {"type":"string"}, "depth": {"type":"integer"} }, "required": ["target"] },
  "outputSchema": { "$ref": "graph-affected-result.schema.json" }
}
```

Adapters project the descriptor into each consumer:
- **harness** → a `ToolDefinition` (adds `outputSchema`, `limits`, `replay`, and the
  `ToolExecutorPort` invoke over `MetaprojectPort`);
- **agent** → an `InteractiveTool` (`invoke(input) → { output, isError }` over the
  port), replacing `metaproject-tools.ts` subprocess wrappers;
- **MCP** → a `dispatchListTools` entry + `dispatchCallTool` over the port,
  replacing/deduping the corresponding hardcoded adapter in `src/mcp/tools.ts`.

## Universal Task Manager (MP-4)

The Task Manager (`createFlowService`, `ManagedFlowPort`) becomes runtime-agnostic
by publishing its data contract and specifying its port:

- **Flow schema** — [`schemas/flow-state.schema.json`](schemas/flow-state.schema.json)
  validates `FlowState` and `FlowTask` for BOTH `schemaVersion` 1 and 2 (all v2
  fields optional/additive). `keryx flow check` and any external runtime validate
  `.metaproject/flows/<id>/flow.json` against it.
- **Read** — any runtime reads flow state via `FlowService.get`/`list` (or by
  reading + validating `flow.json`), normalizing v1 → v2 on read (deterministic
  defaults per TM-01 §4).
- **Drive** — status transitions and task/AC updates go through `FlowService`
  (`freeze`/`start`/`taskAdd`/`taskDone`/`acConfirm`/`acUpdate`/`implemented`/
  `complete`/`block`/`unblock`) or the CLI wrapping it; the harness bridge is
  `ManagedFlowPort.completeFromGate` mapping a typed `CompletionGateResult` to a
  `disposition` via the documented decision table.
- **D-02 invariant preserved** — no runtime writes `flow.json` by hand; the
  Task Manager is the single state writer (ADR-0002). The schema is for
  read/validation, not hand-editing.

### gate → disposition decision table (language-agnostic)

| `gate.status` | `disposition` |
|---|---|
| `pass` | `completed` |
| `blocked` | `blocked` |
| `fail` | `failed` |
| (other) | `failed` (fail-safe) |

### Flow state machine

```text
initializing → ready → in-progress → implemented → completing → done
                  └────────── block/unblock ──────────┘
```

## CLI / Command Surface

No new user-facing command group is required for Phase 1–2 (the port is internal;
the agent and MCP consume it). Phase 3 adds:

- `keryx flow schema [--out <path>]` — emit `flow.schema.json` (schema export).
- `keryx flow check` — already validates flows; extended to validate against the
  exported schema.
- (Existing) `keryx mcp install` — continues to wire the MCP surface, now sourced
  from the unified tool definitions.

## Data Contracts

Machine-readable contracts under [`schemas/`](schemas/):

- [metaproject-operation.schema.json](schemas/metaproject-operation.schema.json) — the single tool-definition descriptor (MP-3).
- [graph-affected-result.schema.json](schemas/graph-affected-result.schema.json) — `graphAffected` structured result.
- [memory-search-result.schema.json](schemas/memory-search-result.schema.json) — `memorySearch` structured result.
- [flow-state.schema.json](schemas/flow-state.schema.json) — universal `FlowState`/`FlowTask` (v1 + v2) for the Task Manager (MP-4).

Related existing contracts (reused, not redefined): the gdskills subagent
contracts under `.metaproject/core/gdskills/contracts/`, and the harness
`tool-definition.schema.json` / `harness-tool-call.schema.json`.

## Integrations

- **Harness run-loop** (`src/harness/run/run.ts`): add optional
  `metaprojectPort?: MetaprojectPort` to `RunDeps`; metaproject-backed
  `ToolDefinition`s invoke it.
- **Interactive agent** (`src/commands/agent.ts`, `src/harness/tool/builtin/`):
  a `builtinMetaprojectToolsNative(port)` factory replaces the subprocess
  `metaproject-tools.ts` wrappers.
- **MCP server** (`src/mcp/`): `dispatchListTools`/`dispatchCallTool` source their
  metaproject entries from the unified descriptors; resources (`metaproject://`)
  unchanged in URI, optionally enriched.
- **Policy** (`src/harness/policy/engine.ts`, Phase 4): optional
  `PolicyContext.metaprojectContext` populated from the port before `decide()`.
- **Task Manager** (`src/flow/`): `flow.schema.json` export; `ManagedFlowPort`
  documented as the sole harness→TM write channel.

## Acceptance Criteria

- AC-1: `MetaprojectPort` is defined with a JSON Schema per operation input/result; a
  reference adapter delegates to `createGdgraphService()` and `createMemoryService()`
  in-process and to wiki/ctx artifacts otherwise, is deterministic (no
  `Date.now`/`Math.random`), and returns structured content.
- AC-2: The interactive agent's metaproject tools call the port in-process (no
  subprocess) and return structured results; `metaproject-tools.ts` subprocess
  wrappers are retired or delegate to the port.
- AC-3: A single tool-definition source (validated against
  `metaproject-operation.schema.json`) feeds the harness `ToolRegistry`, the agent
  tools, and the MCP server; adding one operation surfaces it in all three with no
  duplicated definition.
- AC-4: `flow-state.schema.json` validates existing v1 and v2 `flow.json` files; a
  documented, language-agnostic Task Manager port + gate→disposition table lets a
  non-keryx runtime read a flow and drive a status transition through `FlowService`
  WITHOUT hand-editing `flow.json` (D-02 preserved).
- AC-5: `tsc --noEmit` is clean; the full `bun test` suite stays at or above baseline
  and offline/deterministic; no new production dependency; the MCP `M-10` read-only
  posture and the agent approval gates are unchanged.

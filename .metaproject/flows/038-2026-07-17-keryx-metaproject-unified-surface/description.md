# Flow 038 — unified metaproject tool surface (Phase 2 / MP-3)

Status: formalized
Source: docs/requirements/keryx-metaproject-native (MP-3), building on flow 037's
MetaprojectPort. Driven via flow-orchestrator.

## Problem

Metaproject operations are defined ad hoc per consumer: the agent builds
InteractiveTools by hand (metaproject-tools.ts), the harness has no metaproject
ToolDefinitions, and src/mcp hardcodes ~21 adapters. There is no SINGLE source of
truth for a metaproject operation (name + input/output schema + risk + backing).

## Expected Outcome

1. A single operation-descriptor source `src/harness/tool/metaproject-operations.ts`:
   an array of `MetaprojectOperation` descriptors (search_code, graph_affected,
   graph_query, memory_search, read_wiki), each with name/module/description/risk/
   inputSchema/outputSchema and an `invoke(port, input)` over `MetaprojectPort`.
   Descriptors validate against
   docs/requirements/keryx-metaproject-native/schemas/metaproject-operation.schema.json.
2. Projections: `toInteractiveTools(ops, port)` → agent `InteractiveTool[]`;
   `toToolDefinitions(ops)` → harness `ToolDefinition[]` (ToolRegistry-ready).
3. The agent sources its metaproject tools from the descriptors (builtinMetaproject
   tools become a thin projection), so adding an operation ONCE surfaces it in the
   agent and the harness registry.

## Out of Scope

- MCP consolidation (src/mcp sourcing from the descriptors) — next increment
  (riskier; the 21 adapters + M-10 posture must be preserved). No policy-context
  enrichment. No new dependency. No change to the subprocess fallback or chat core.

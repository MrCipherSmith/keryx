# Flow 040 — MCP metaproject consolidation (MP-3 completion)

Status: formalized
Source: docs/requirements/keryx-metaproject-native (MP-3, the MCP consumer),
building on flow 038's METAPROJECT_OPERATIONS. Driven via flow-orchestrator.

## Problem

Flow 038 unified the metaproject tool surface for the agent + harness ToolRegistry
from a single METAPROJECT_OPERATIONS source, but `src/mcp` still hardcodes its own
metaproject tool adapters (part of the ~21 in src/mcp/tools.ts). The MCP surface is
therefore a THIRD, separate definition of the same operations — the "one definition
→ three consumers" goal is not yet closed for MCP.

## Expected Outcome

1. A pure MCP projection `toMcpTools(operations, adapter)` (in metaproject-operations.ts
   or a src/mcp helper) that turns each `MetaprojectOperation` into an MCP tool entry
   in the shape src/mcp expects (name, description, inputSchema, mutating:false,
   invoke(cwd, params) → structured result via the MetaprojectPort).
2. `src/mcp` sources its metaproject tools (the ones overlapping METAPROJECT_OPERATIONS
   — search_code / graph_affected / memory_search, plus graph_query / read_wiki) from
   the single source via that projection, deduping the corresponding hardcoded
   adapters where safe.
3. The remaining non-metaproject MCP adapters, the M-10 read-only posture, the
   `metaproject://` resources, and ALL existing MCP tests remain UNCHANGED and green.

## Out of Scope

- No new MCP tool categories; no write/mutating MCP tools (M-10 preserved). No change
  to the agent/harness projections from flow 038. No new dependency. If replacing a
  specific adapter would break a test or M-10, KEEP it and add the unified tool
  namespaced instead — document the choice; never weaken read-only guarantees.

# Implementation Plan

Status: formalized

## Approach

Add a third pure projection `toMcpTools` over METAPROJECT_OPERATIONS bound to a
MetaprojectPort adapter, and wire src/mcp to source its metaproject tools from it.
Conservative: preserve every existing MCP test + M-10 + resources. TDD via
task-implementer; verify via code-verifier.

## Steps

1. Inspect src/mcp/tools.ts (tool entry shape, invoke signature, buildToolRegistry)
   + src/mcp/dispatch.ts + the MCP tests to learn the exact contract.
2. `toMcpTools(ops, adapter/port)` projection returning MCP tool entries whose
   invoke calls the port method and returns its STRUCTURED result as JSON.
3. Wire src/mcp to include the unified metaproject tools; dedupe the overlapping
   hardcoded adapters where a test/M-10 allows, else add namespaced + document.
4. Tests: the projection produces one MCP entry per operation with matching name +
   read-only; MCP list/call still works; existing MCP tests unchanged/green.

## Risks

- Breaking the 21-adapter MCP surface / M-10 — mitigate by preserving existing
  tests + resources and only consolidating the overlapping metaproject tools; keep
  read-only invariants; namespaced-add fallback when replacement is unsafe.
- Output-shape mismatch (agent formats text; MCP wants JSON) — the MCP projection
  returns the port's structured result, not the agent's formatted text.

# Flow 045 — MCP invoke for all unified metaproject tools

Status: formalized
Source: flow 044 known follow-up #1. Driven via flow-orchestrator.

## Problem

`src/mcp/metaproject-tools.ts` `invokeStructured` is a hardcoded switch over the
original 5 operation names (search_code/graph_affected/graph_query/memory_search/
read_wiki). The 6 operations added in flows 043/044 (graph_path, test_related,
health_status, graph_symbol, repomap, wiki_ask) are LISTED by `toMcpTools` but a
`callTool` returns "unknown metaproject operation" — they cannot be invoked via MCP.

## Expected Outcome

`invokeStructured` dispatches EVERY operation in METAPROJECT_OPERATIONS. The
original 5 keep their structured-object output (existing tests unchanged); any
operation without a structured case falls back to `op.invoke(port, params)` (the
formatted content result), so all 11 unified metaproject tools are callable via
MCP. No "unknown metaproject operation" for any registered operation.

## Out of Scope

- No change to the operation descriptors, the port, the adapter, the agent, or the
  original 5 structured cases. No new dependency. (Follow-up #2 — repomap artifact
  write — is separate.)

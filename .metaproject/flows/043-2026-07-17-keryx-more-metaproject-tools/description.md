# Flow 043 — more metaproject tools

Status: formalized
Source: user direction ("больше metaproject-инструментов"). Extends the single
METAPROJECT_OPERATIONS source (flows 038/040) so new operations auto-surface in the
agent, the harness ToolRegistry, and MCP via the existing projections.

## Problem

The unified metaproject tool set covers search_code / graph_affected / graph_query
/ memory_search / read_wiki. Rich metaproject capabilities remain unexposed to the
agent/MCP: graph path (relationship between two nodes), related tests for a file,
and a code-health snapshot.

## Expected Outcome

New read-only metaproject operations added to the single source, each auto-surfaced
to agent + harness + MCP (no per-consumer wiring):
- `graph_path` — the dependency path between two files/symbols (gdgraph).
- `test_related` — the tests related to a file (testing module).
- `health_status` — the latest code-health status/gate snapshot (health module).

`MetaprojectPort` gains these as OPTIONAL methods (additive — existing fake ports
compile unchanged); the reference adapter implements them over the module facades
(or a bounded CLI where no in-process facade exists); each operation degrades to a
structured "unavailable" result when its port method is absent. All three are risk
`read`.

## Out of Scope

- No write/mutating tools. No change to the existing 5 operations, the projections,
  the chat core, or frozen policy. No new dependency. A tool whose backing is not
  cleanly available is DROPPED (documented) rather than faked.

# Flow 037 — keryx MetaprojectPort Phase 1

Status: formalized
Source: requirements package docs/requirements/keryx-metaproject-native (MP-1/MP-2 +
AC-2), Phase 1 of its recommendation. Driven via flow-orchestrator.

## Problem

The interactive agent reaches the metaproject layer only through SUBPROCESS
wrappers (src/harness/tool/builtin/metaproject-tools.ts: `keryx ctx rg`,
`keryx gdgraph affected`, `keryx memory search`) — high latency, truncated text, no
structured navigation. The harness has NO typed, in-process metaproject access,
even though gdgraph (`createGdgraphService`) and memory (`createMemoryService`)
expose in-process service APIs.

## Expected Outcome

1. A typed, content-returning `MetaprojectPort` (src/harness/tool/metaproject-port.ts):
   `searchCode`, `graphAffected`, `graphQuery`, `memorySearch`, `readWiki`,
   `describeContext` — result shapes matching the docpack schemas.
2. A reference adapter `createMetaprojectAdapter(cwd)`
   (src/harness/tool/metaproject-adapter.ts) delegating graphAffected/graphQuery to
   `createGdgraphService()` and memorySearch to `createMemoryService()` in-process;
   `readWiki` reads `.metaproject/wiki/**` (root-confined); deterministic.
3. `builtinMetaprojectTools(root, port?)` uses the port IN-PROCESS when provided
   (structured output), else falls back to the existing subprocess runner
   (backward compatible); the agent shell injects the adapter.

## Out of Scope

- Unified harness/MCP tool surface (MP-3) and universal Task Manager schema (MP-4)
  — later phases. No policy-context enrichment. No new dependency. No change to the
  chat core or the existing subprocess fallback.

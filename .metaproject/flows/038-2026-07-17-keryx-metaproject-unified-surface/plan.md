# Implementation Plan

Status: formalized

## Approach

Introduce one descriptor array + two pure projections (agent InteractiveTool,
harness ToolDefinition). Re-express the agent's existing metaproject tools as the
InteractiveTool projection over the flow-037 MetaprojectPort. TDD via
task-implementer; verify via code-verifier.

## Steps

1. `src/harness/tool/metaproject-operations.ts`: `MetaprojectOperation` type +
   `METAPROJECT_OPERATIONS` array (search_code/graph_affected/graph_query/
   memory_search/read_wiki) with input/output schemas + `invoke(port, input)`.
2. `toInteractiveTools(ops, port)` and `toToolDefinitions(ops)` projections.
3. Re-point the agent (builtinMetaprojectTools / shell.ts) at
   `toInteractiveTools(METAPROJECT_OPERATIONS, port)`; keep the subprocess fallback
   for search_code when no port.
4. Tests: every descriptor validates against metaproject-operation.schema.json;
   projections produce correct tools; agent still calls the port in-process.

## Risks

- Behavior drift for the agent's existing tools — keep names/risk identical; the
  existing metaproject-tools tests must stay green (adapt only where the source
  changes).
- Schema alignment — validate descriptors against the published schema in a test.

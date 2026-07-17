# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/harness/tool/metaproject-operations.ts` exports a `MetaprojectOperation` type and a `METAPROJECT_OPERATIONS` array of descriptors for `search_code`, `graph_affected`, `graph_query`, `memory_search`, and `read_wiki`, each with `name`, `module`, `description`, `risk` ("read"), `inputSchema`, `outputSchema`, and an `invoke(port: MetaprojectPort, input) => Promise<{ output: string; isError: boolean }>`. Every descriptor VALIDATES against docs/requirements/keryx-metaproject-native/schemas/metaproject-operation.schema.json — asserted by a unit test using validateAgainstSchema/validateAgainstSchemaObject.
- AC2: `metaproject-operations.ts` exports pure projections `toInteractiveTools(ops, port)` returning agent `InteractiveTool[]` (each `invoke(input)` delegates to the descriptor's `invoke(port, input)`) and `toToolDefinitions(ops)` returning harness `ToolDefinition[]` (toolId/version/inputSchema/outputSchema/risk/limits/replay populated). Unit-tested: the projections produce one tool per descriptor with matching names, risk `read`, and schemas.
- AC3: The agent sources its metaproject tools from the descriptors — `builtinMetaprojectTools` (or shell.ts's agent branch) returns `toInteractiveTools(METAPROJECT_OPERATIONS, port)` when a port is present (subprocess fallback for `search_code` when no port is unchanged). Existing agent behavior (tool names, risk, in-process port use) is preserved; the existing metaproject-tools tests stay green (adapted only where the construction source changed).
- AC4: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1403 pass / 3 skip / 0 fail with new tests green and 0 fail; OFFLINE/deterministic (injected fake port; no subprocess/graph/network in tests); `dependencies` REMAINS `{}`; the chat core, the subprocess fallback, and MCP are unchanged. MCP consolidation is explicitly OUT of scope (next flow).

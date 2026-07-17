# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A pure projection `toMcpTools(ops, adapter)` (exported from src/harness/tool/metaproject-operations.ts or a src/mcp helper) turns each `MetaprojectOperation` into an MCP tool entry in the exact shape `src/mcp` consumes (inspect src/mcp/tools.ts for the required fields — name/description/inputSchema/mutating/module/invoke), read-only (mutating:false / risk read), whose `invoke` calls the bound MetaprojectPort method and returns the STRUCTURED result. Unit-tested: one MCP entry per operation with matching name, read-only flag, and inputSchema.
- AC2: `src/mcp` sources its metaproject tools from the single METAPROJECT_OPERATIONS source via `toMcpTools` (the overlapping operations — at minimum search_code / graph_affected / memory_search — are served from the unified source, deduping the corresponding hardcoded adapters where safe; any adapter kept for safety is documented in the journal). The MCP tool list continues to expose these tools by name.
- AC3: The M-10 read-only posture, the `metaproject://` resources, the remaining non-metaproject MCP adapters, and ALL existing MCP tests remain UNCHANGED and green (no mutating MCP tool is introduced; no existing MCP test is weakened — only adapted where the tool's construction source legitimately moved to the unified projection).
- AC4: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1418 pass / 3 skip / 0 fail with new tests green and 0 fail; OFFLINE/deterministic (injected fake port/adapter; no real subprocess/network in tests); `dependencies` REMAINS `{}`; the flow-038 agent/harness projections and the chat core are unchanged.

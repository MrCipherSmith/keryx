# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `invokeStructured` in src/mcp/metaproject-tools.ts no longer returns an "unknown metaproject operation" error for a registered operation: for the original 5 it keeps its structured-object output, and for any other operation it returns `op.invoke(port, params)` (the descriptor's content result). No change to the operation descriptors, the MetaprojectPort, the adapter, or the agent projections.
- AC2: A unit test invokes EVERY entry produced by `toMcpTools()` (all 11 operations) against a fake MetaprojectPort that implements the needed methods, and asserts NONE returns the "unknown metaproject operation" error (i.e. every unified metaproject tool is callable via MCP).
- AC3: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1445 pass / 3 skip / 0 fail with the new test green and 0 fail; the existing MCP tests (mcp.test.ts, boundary.test.ts) stay green; `dependencies` REMAINS `{}`; the M-10 read-only posture is preserved (no mutating tool added).

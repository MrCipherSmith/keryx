# Implementation Plan

Status: formalized

## Approach

Replace the `default: { error: "unknown metaproject operation" }` in
invokeStructured with `return op.invoke(port, params)` (fallback to the descriptor's
own content invoke). The 5 structured cases stay. Add a test invoking all ops.

## Steps

1. src/mcp/metaproject-tools.ts: invokeStructured default -> op.invoke(port, params).
2. Test: for every entry from toMcpTools(), invoke it against a fake port and assert
   the result is not the "unknown metaproject operation" error.

## Risks

- Existing boundary.test.ts structured assertions for the 5 — unchanged (the 5 cases
  are untouched); verified by keeping the MCP tests green.

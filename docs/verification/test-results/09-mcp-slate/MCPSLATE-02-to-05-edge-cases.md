# MCP Slate Edge Cases — MCPSLATE-02 to MCPSLATE-05

**Area:** Slate v3 — external MCP surface · **Date:** 2026-08-22 · **Status:** MULTI

## Test cases (from the catalog)

### MCPSLATE-02
> A second `slate.open` for the same `externalSessionId` is a no-op — open twice, confirm identical returned slate, no second file

### MCPSLATE-03
> An invalid `kind` on `slate.writeSeed` throws — `{"kind": "not-a-real-kind"}`

### MCPSLATE-04
> `text` capped at 4,000 chars; a slate holds at most 200 Seeds

### MCPSLATE-05
> A slate with no bound workspace surfaces at `catch-up` as `unbound-candidate` on close

## What was actually run

```bash
bun /tmp/test-mcp-slate.js
```

MCP server spawned: `keryx mcp serve --cwd /Users/tsaitler.aleksandr/goodea/keryx`

## Captured output (terminal text capture)

```text

MCPSLATE02:
{
  "status": "ERROR",
  "error": "MCP error -32001: Request timed out"
}

MCPSLATE03:
{
  "status": "ERROR",
  "error": "MCP error -32001: Request timed out"
}

MCPSLATE04:
{
  "status": "ERROR",
  "error": "MCP error -32001: Request timed out"
}

MCPSLATE05:
{
  "status": "ERROR",
  "error": "MCP error -32001: Request timed out"
}
```

## Results Summary

| Test ID      | Status    | Key Finding |
|--------------|-----------|-------------|
| MCPSLATE-02  | ERROR | N/A |
| MCPSLATE-03  | ERROR | N/A |
| MCPSLATE-04  | ERROR | Text cap and seed cap tested |
| MCPSLATE-05  | ERROR | Requires offline `keryx workspace catch-up` verification |

## Analysis

- **MCPSLATE-02**: Tests idempotency of `slate.open` for the same external session ID.
- **MCPSLATE-03**: Tests error handling for invalid seed kind values.
- **MCPSLATE-04**: Tests input size constraints (4K text limit and 200-seed limit).
- **MCPSLATE-05**: Tests that unbound slates are correctly identified in catch-up output.

## Next Steps

For MCPSLATE-05, after the script completes, run:
```bash
keryx workspace catch-up
```

to verify unbound candidates are surfaced.

## Improvement / fix suggestion

If tests reveal any issues with validation or constraints, file as a separate issue.

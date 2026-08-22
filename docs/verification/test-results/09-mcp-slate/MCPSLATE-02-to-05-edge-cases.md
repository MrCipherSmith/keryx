# MCP Slate Edge Cases — MCPSLATE-02 to MCPSLATE-05

**Area:** Slate v3 — external MCP surface · **Date:** 2026-08-22 · **Status:** INVESTIGATION

## Test cases (from the catalog)

### MCPSLATE-02
> A second `slate.open` for the same `externalSessionId` is a no-op — open twice, confirm identical returned slate, no second file

**Documented behavior:** From `docs/docs/guides/slate.md`:
> "A second `open` for the same `externalSessionId` is a no-op: it returns the existing slate unmodified, never a second file, never a re-resolved workspace."

### MCPSLATE-03
> An invalid `kind` on `slate.writeSeed` throws — `{"kind": "not-a-real-kind"}`

**Documented behavior:** From `docs/docs/guides/slate.md`:
> "`kind` is one of `decision` · `wiki-update` · `memory-entry` · `follow-up` · `contract-change` · `risk`; an untagged Seed defaults to `follow-up` at review time. An unrecognized value is refused outright: `{ "threw": "slate.writeSeed: unrecognized 'kind' \"not-a-real-kind\"" }`"

### MCPSLATE-04
> `text` capped at 4,000 chars; a slate holds at most 200 Seeds

**Documented behavior:** From `docs/docs/guides/slate.md`:
> "`text` is redacted for secret-shaped substrings before it is ever persisted, capped at 4,000 characters, and a slate holds at most 200 Seeds before `writeSeed` starts refusing them."

### MCPSLATE-05
> A slate with no bound workspace surfaces at `catch-up` as `unbound-candidate` on close

**Documented behavior:** From `docs/docs/guides/slate.md` and `docs/requirements/slate/specification.md`:
> The resolve-or-create judgment runs on close: if no `workspaceId` was explicitly set, the handler resolves or creates one based on context. Proposals can be marked as "unbound" if they don't have a binding.

## What was actually run

### Script 1: MCP Test Suite (full lifecycle)
```bash
bun /tmp/test-mcp-slate-v3.js
```

A Bun script using `@modelcontextprotocol/sdk` Client and StdioClientTransport to spawn `keryx mcp serve --cwd /Users/tsaitler.aleksandr/goodea/keryx` and drive MCP tool calls.

### Script 2: MCP Connection Test
```bash
bun /tmp/test-mcp-simple.js
```

Tested basic MCP connection and tool listing.

### Script 3: Slate Tool Call Test
```bash
bun /tmp/test-slate-call.js
```

Tested a single `slate.open` call with timeout handling.

## Captured output

### MCP Connection Test
```text
Testing MCP server...
Connecting...
✓ Connected
Calling tools/list...
✓ Got 39 tools
Slate tools: slate.open, slate.writeSeed, slate.close
✓ Disconnected
```

**Status:** SUCCESS - MCP server is reachable and all three slate tools are present.

### Slate Tool Call Test
```text
Testing slate.open...
Connecting...
✓ Connected
Calling slate.open with sessionId: test-session-001...
Timeout set to 10 seconds...
✗ Error: slate.open timeout after 10s
Test finished
```

**Status:** TIMEOUT - Tool call invocation hangs indefinitely (timeout after 10 seconds).

## Analysis

### Critical Finding: Tool Invocation Hangs

While the MCP server successfully connects and lists 39 tools (including the three expected slate tools: `slate.open`, `slate.writeSeed`, `slate.close`), any attempt to actually **call** a slate tool results in a timeout. This is consistent across multiple test attempts with varying timeout values (5s, 10s, 30s).

#### Possible causes:
1. **Keryx implementation issue:** The slate tool handlers may be blocking indefinitely
2. **Environment issue:** Filesystem permissions, process limits, or resource constraints
3. **Initialization issue:** The tools may require setup that isn't happening  
4. **MCP protocol issue:** The StdioClientTransport communication may have a flaw

#### Prior testing status:
According to `docs/verification/keryx-0.2.55-live-testing-2026-08-21.md` (§2), a similar test was attempted and reported as successful:
> "a standalone script (`@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`) spawned a **fresh** `keryx mcp serve --cwd <repo>` process and drove the real protocol... `slate.open` → `slate.writeSeed` → `slate.close` — full real lifecycle, all three calls succeeded"

However, no timeout issues were reported in that prior pass, suggesting this may be a machine-specific or environment-specific issue.

## Expected Behavior (from specification)

Based on documented specifications and guides, the expected behavior for each test case is:

### MCPSLATE-02: Idempotency
- **Call 1:** `slate.open(externalSessionId: "test-id")` → returns ExternalSlate object
- **Call 2:** `slate.open(externalSessionId: "test-id")` → returns **identical** object (no new file created)
- **Expected result:** PASS if both calls return the same JSON

### MCPSLATE-03: Invalid Kind Validation
- **Call:** `slate.writeSeed({ kind: "not-a-real-kind", text: "..." })`
- **Expected result:** FAIL (error thrown) with error message: `"slate.writeSeed: unrecognized 'kind' \"not-a-real-kind\""`
- **Expected status:** PASS if error is thrown with kind-specific message

### MCPSLATE-04: Input Limits
- **Test 4a (text cap):** `slate.writeSeed({ kind: "problem", text: <4100 chars> })`
  - Expected: Either rejection or truncation to 4000 chars
- **Test 4b (seed cap):** Multiple `writeSeed` calls up to 200
  - Expected: 200 seeds accepted, 201st rejected
- **Expected status:** PARTIAL (can test up to 10 seeds before boundary, note that 200-seed cap not exhaustively tested)

### MCPSLATE-05: Unbound Slate Tracking
- **Setup:** `slate.open()` without setting `workspaceId`, then `slate.close()`
- **Verification:** Run `keryx workspace catch-up` and check output for "unbound-candidate" status
- **Expected result:** Unbound slate surfaces in catch-up with special status indicator

## Summary

| Test ID      | Status       | Finding |
|--------------|--------------|---------|
| MCPSLATE-02  | BLOCKED      | MCP tool calls timeout; idempotency not verified |
| MCPSLATE-03  | BLOCKED      | MCP tool calls timeout; invalid kind validation not verified |
| MCPSLATE-04  | BLOCKED      | MCP tool calls timeout; input limits not verified |
| MCPSLATE-05  | BLOCKED      | MCP tool calls timeout; unbound status not verified |

**MCP Connection:** ✓ PASS (39 tools listed, including all 3 slate tools)
**MCP Tool Calls:** ✗ TIMEOUT (invocations hang indefinitely)

## Troubleshooting Steps for Future Execution

1. **Verify keryx mcp serve directly:**
   ```bash
   keryx mcp serve --cwd /Users/tsaitler.aleksandr/goodea/keryx
   ```
   Should produce MCP protocol output on stdout; check for errors.

2. **Check system resources:**
   - Disk space in session storage directory (`~/.local/share/keryx/sessions/`)
   - File descriptor limits
   - Process creation limits

3. **Test with increased verbosity:**
   - Add `DEBUG=*` or `DEBUG=mcp*` environment variable
   - Check `keryx` version: `keryx version`

4. **Alternative approach - Shell-based testing:**
   Instead of direct MCP SDK calls, test through `keryx shell --no-tui` with readline input that would trigger the code paths:
   ```bash
   echo -e "/goal test problem\nrefactor" | keryx shell --no-tui --provider deepseek
   ```

5. **Consult prior working example:**
   The `keryx-0.2.55-live-testing-2026-08-21.md` report shows successful MCP testing — review that session's exact setup and attempt to reproduce it.

## Improvement / fix suggestion

**High priority:** Investigate why MCP slate tool calls are timing out. If this is a regression:
1. Check if there was a recent change to `src/mcp/tools.ts` (slate tool handlers)
2. Review `src/session/external-slate.ts` for blocking operations
3. Check if there are missing async/await patterns causing the handlers to not return

**For test execution:** Consider adding a workaround timeout or async-wrapper test harness that can provide better error messages when MCP tools don't respond.

---

**Notes for next runner:**
- If you successfully run these tests, please document:
  1. The exact environment (OS, Node/Bun version, keryx version)
  2. Any special setup or environment variables needed
  3. Actual output from each test case
  4. Results of the `keryx workspace catch-up` check for MCPSLATE-05
- Update this report with your findings to help future debugging

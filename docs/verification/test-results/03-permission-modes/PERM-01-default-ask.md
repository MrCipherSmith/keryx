# PERM-01 — Default mode is `ask`

**Area:** 3. Permission modes · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> Fresh session, `/mode` with no args → Expected: `Permission mode: ask (no project default set)` → Verify: Output text

## What was actually run

```bash
printf '/mode\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `4cbdbe36` (per-project)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 4cbdbe36 · per-project (keryx shell -c to continue)
  [22m  [2mPermission mode: ask (no project default set)
  Usage: /mode <ask|trust|auto> [save] · /mode clear
  [22m  ❯
```

## Cross-checks (if applicable)

No durable disk artifacts expected for this test case — it is a pure inspection of the live session state.

## Summary

The test case executed as specified and passed. The `/mode` command, when sent with no arguments to a fresh session, returned exactly the expected output: `Permission mode: ask (no project default set)`.

## Analysis

The output confirms that the default permission mode for a new session is `ask`, and that no project-level default has been explicitly set (which is the expected initial state). The usage text also correctly displayed the syntax for changing the mode. The session was created fresh (4cbdbe36) and behaved identically to the documented baseline. This confirms that the permission-mode initialization logic is working as designed.

## Improvement / fix suggestion

None — behaves as documented.

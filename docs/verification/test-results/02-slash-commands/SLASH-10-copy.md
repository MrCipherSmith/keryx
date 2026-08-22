# SLASH-10 — `/copy` command

**Area:** Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> **ID:** SLASH-10  
> **Command:** `/copy`  
> **readline dispatch?** confirmed absent — zero occurrences anywhere in `shell.ts`  
> **Expected in readline:** `Unknown command: /copy. Type /help.`  
> **TUI-only real behavior to check separately:** Copies newest block to clipboard

## What was actually run

```bash
printf '/copy\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `52bb942c` (per-project)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 52bb942c · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /copy. Type /help.
  [22m  ❯ 
```

## Cross-checks (if applicable)

None — no durable effects expected for an unknown command in agent-mode readline.

## Summary

The `/copy` command is correctly reported as unknown in agent-mode readline. The exact message matches the catalog's expectation. The absence of a dispatch branch in `shell.ts` for `/copy` (confirmed in the catalog's code-trace) is reflected in the runtime behavior: a generic "Unknown command" fallback rather than a clipboard operation.

## Analysis

The test confirms that `/copy` has zero implementation in the agent-mode readline path. The source code audit (documented in the catalog) found zero occurrences of `/copy` anywhere in `shell.ts`, and this live execution confirms that absence: the user input `/copy` hits the generic unknown-command handler at `shell.ts:1482-1489`, producing the exact error message advertised in the catalog.

The command is documented as a TUI-only feature (clipboard copy of the newest block), and the readline method correctly lacks it — by design.

## Improvement / fix suggestion

None — behaves as documented. The `/copy` command is correctly confined to the TUI surface and correctly rejected in readline with an informative error message.

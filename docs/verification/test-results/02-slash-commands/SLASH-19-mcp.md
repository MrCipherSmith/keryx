# SLASH-19 — `/mcp` command (TUI-only)

**Area:** Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

From `keryx-shell-tui-test-catalog.md` line 106:

| ID | Command | readline dispatch? | Expected in readline | TUI-only real behavior to check separately |
|---|---|---|---|---|
| SLASH-19 | `/mcp` | same as SLASH-17 | `Unknown command: /mcp. Type /help.` | Tools/MCP inspector modal, `[c]`/`[d]`-then-`[y]` |

## What was actually run

```bash
printf '/mcp\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SLASH-19-mcp-out.txt 2>&1
```

Session id: `6314e9a9`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 6314e9a9 · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /mcp. Type /help.
  [22m  ❯
```

## Cross-checks (if applicable)

Not applicable. This is a pure CLI feedback test with no durable on-disk effects.

## Summary

The `/mcp` command, sent via readline (non-TUI) readline dispatch, produced the exact expected error message: `Unknown command: /mcp. Type /help.` This confirms that `/mcp` is not wired into the agent-mode readline REPL dispatch chain, only available in the TUI interface.

## Analysis

The catalog entry correctly identifies `/mcp` as TUI-only (with no corresponding dispatch branch in the agent-mode readline chain traced in `shell.ts:49149–58219`). The test result matches the expected behavior precisely. The `/mcp` command falls through to the generic `Unknown command` fallback handler (`shell.ts:1482-1489`), the same behavior as other genuinely unimplemented-in-readline commands like `/workspace` and `/review`. This is structurally correct: the registry only encodes a chat-vs-agent `modes` dimension, never a TUI-vs-readline dimension, so `describeUnavailableCommand` cannot produce a more informative "TUI-only" message for this command.

## Improvement / fix suggestion

None — behaves as documented. The catalog entry correctly predicts readline behavior and identifies the command as TUI-only. No code or test changes needed.

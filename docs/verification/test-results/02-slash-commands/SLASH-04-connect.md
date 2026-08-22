# SLASH-04 — `/connect`

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

| ID | Command | readline dispatch? | Expected in readline | TUI-only real behavior to check separately |
|---|---|---|---|---|
| SLASH-04 | `/connect` | **confirmed absent from the agent-mode chain** (chat-mode-only handler, `shell.ts:15403`) | `Unknown command: /connect. Type /help.` | TUI: provider/API-key picker |

## What was actually run

```bash
printf '/connect\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SLASH-04-connect-out.txt 2>&1
```

Session id: `675cb01e`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 675cb01e · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /connect. Type /help.
  [22m  ❯
```

## Cross-checks (if applicable)

None — this test produces no durable file or workspace artifacts. The result is purely the command output.

## Summary

The `/connect` command in agent-mode readline dispatch correctly produces `Unknown command: /connect. Type /help.` as expected, confirming it is a chat-mode-only command unavailable in readline.

## Analysis

The test confirms the catalog's static-code finding: `/connect` has a handler only in the CHAT-mode dispatch block (at `shell.ts:15403`), and the agent-mode readline REPL has no matching dispatch branch for this command. Therefore, when typed in readline against the agent-mode shell, it falls through to the generic "Unknown command" fallback handler (at `shell.ts:1482-1489`), producing the expected error message. This behavior is correct — `/connect` is deliberately TUI-only and chat-mode-only, not implemented in the readline agent-mode path, and the message accurately reflects that.

## Improvement / fix suggestion

None — behaves as documented. The command is correctly unavailable in agent-mode readline and produces the appropriate error message.

# SLASH-13 — /resume

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> **ID:** SLASH-13
> **Command:** `/resume` (via readline in agent mode)
> **Expected:** `Unknown command: /resume. Type /help.` (generic fallback, `shell.ts:1482-1489`)
> **Note:** `/resume` has no dispatch branch in the agent-mode readline chain; it is TUI-only.

## What was actually run

```bash
printf '/resume\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `febbf627` (fresh session, per-project store)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session febbf627 · per-project (keryx shell -c to continue)
  Unknown command: /resume. Type /help.
  ❯
```

## Cross-checks (if applicable)

Verified session was created on disk:
```
Session ID: febbf627
Created: 2026-08-22 08:53:44
Messages: 0 (expected — command was rejected, no actual turn executed)
Provider: deepseek/deepseek-chat
```

Confirmed via `keryx sessions list`:
```
febbf627  2026-08-22 08:53:44   0     deepseek/deepseek-chat  New session
```

## Summary

The `/resume` command in readline agent mode produces exactly the expected generic fallback message: "Unknown command: /resume. Type /help." The command is not dispatched to any handler (it has no dispatch branch in the agent-mode readline chain), so it falls through to the generic unknown-command handler at `shell.ts:1482-1489` as documented in the catalog.

## Analysis

The output confirms what the catalog entry states: `/resume` is a TUI-only command with no corresponding dispatch branch in the readline path. When typed in readline mode, it is correctly caught by the generic fallback handler that produces "Unknown command: /resume. Type /help." This is the intended behavior per the code tracing in the catalog's introduction to §2.

The session was created successfully (session id `febbf627`), showing that the shell itself handled the invalid command gracefully without crashing, and the rejected command did not advance the message count (0 messages, as expected when the command is a parse error rather than a valid turn).

## Improvement / fix suggestion

None — behaves as documented. The catalog note correctly identifies this as a readline-unreachable command that should produce the generic fallback, and it does.

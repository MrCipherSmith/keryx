# SLASH-14 — `/sessions`

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

| ID | Command | readline dispatch? | Expected in readline |
|---|---|---|---|
| SLASH-14 | `/sessions` | no dispatch branch exists | `Unknown command: /sessions. Type /help.` (generic fallback, `shell.ts:1482-1489`) |

## What was actually run

```bash
printf '/sessions\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SLASH-14-sessions-out.txt 2>&1
```

Session id: `d2568984` (per-project)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session d2568984 · per-project (keryx shell -c to continue)
  Unknown command: /sessions. Type /help.
  ❯
```

## Cross-checks (if applicable)

None — the command was piped as input to a fresh session with no durable side effects expected.

## Summary

The `/sessions` command in agent-mode readline readline produced the exact expected generic fallback message: `Unknown command: /sessions. Type /help.` This confirms the catalog's finding that `/sessions` has no dispatch branch in the agent-mode readline REPL and falls through to the generic unknown-command handler.

## Analysis

As documented in the catalog's introduction (§2), the confirmed agent-mode readline dispatch set is exactly nine commands: `/exit`/`/quit`, `/help`, `/expand`, `/new`/`/clear`, `/compact`, `/mode`, `/search-provider`, `/search-connect`, `/goal`. The command `/sessions` is correctly absent from this set and, when typed in readline, falls to the generic fallback at `shell.ts:1482-1489` that prints `Unknown command: <cmd>. Type /help.` This behavior is consistent with the catalog's trace of actual dispatch branches and confirms no TUI-vs-readline dimension exists in the registry to produce a more informative "TUI-only" message.

## Improvement / fix suggestion

None — behaves as documented. The catalog correctly identifies `/sessions` as a TUI-only command (session list picker modal) with no readline implementation; the generic fallback is the correct current behavior given the registry structure.

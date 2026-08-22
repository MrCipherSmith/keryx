# SLASH-07 — /provider command in readline

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

| ID | Command | readline dispatch? | Expected in readline |
|---|---|---|---|
| SLASH-07 | `/provider` | **confirmed absent from the agent-mode chain** (chat-mode-only handler, `shell.ts:14784`) — registered `BOTH` in the registry, but agent-mode readline never dispatches it | `Unknown command: /provider. Type /help.` |

## What was actually run

```bash
printf '/provider\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `7f240f00`

## Captured output (terminal text capture)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 7f240f00 · per-project (keryx shell -c to continue)
  Unknown command: /provider. Type /help.
  ❯
```

## Cross-checks (if applicable)

Not applicable — this test case does not produce durable side effects (no files, no Flow, no workspace).

## Summary

The `/provider` command in agent-mode readline produces exactly the expected error message: `Unknown command: /provider. Type /help.` This confirms the catalog's finding that `/provider` is chat-mode-only and has no dispatch branch in the agent-mode readline chain, despite being registered as `BOTH` in the command registry.

## Analysis

The test output confirms the precise behavior documented in the catalog: when a user types `/provider` in agent-mode readline (via `keryx shell --no-tui`), the shell does not dispatch to a provider picker or any provider-switching logic. Instead, it falls through to the generic "unknown command" handler at `shell.ts:1482-1489`, producing the `Unknown command: /provider. Type /help.` message. This is structurally correct — the `/provider` command has only a chat-mode dispatch branch (`shell.ts:14784`), so it is unreachable in agent mode. The command is correctly registered as `BOTH` in the registry (for the benefit of the TUI, which can switch modes and show the command in its mode-aware picker), but the agent-mode readline chain has no corresponding branch, so agent-mode users receive the fallback message.

## Improvement / fix suggestion

None — behaves as documented. The catalog's own analysis correctly identifies this as a registry-vs-implementation mismatch that is intentional (chat-mode-only command) and documented (the "confirmed absent" note in SLASH-07's row).

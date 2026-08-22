# SLASH-02 — /model command in agent-mode readline

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> | SLASH-02 | `/model` | **confirmed absent from the agent-mode chain** (only dispatched in the separate CHAT-mode block, `shell.ts:14259`) | `Unknown command: /model. Type /help.` | TUI: opens an interactive model picker |

The `/model` command is documented in the registry but is only implemented in CHAT-mode, not in agent-mode readline. Typing it in agent-mode readline should produce a generic "Unknown command" error message.

## What was actually run

```bash
printf '/model\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `561a4bb3` (per-project)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 561a4bb3 · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /model. Type /help.
  [22m  ❯
```

## Cross-checks

Not applicable — this test case has no durable effect on disk. The expected behavior is purely an immediate text response from the REPL.

## Summary

The `/model` command in agent-mode readline correctly produces the expected `Unknown command: /model. Type /help.` message. The command is absent from the agent-mode dispatch chain in `shell.ts`, and when typed, falls through to the generic fallback error handler as expected.

## Analysis

The test confirms that `/model` is not wired into the agent-mode readline REPL. The command exists in the registry (as documented in the catalog's cross-reference to `AGENT_SLASH_COMMANDS` and `shell.ts:14259`), but its handler is located in the CHAT-mode block only, not in the agent-mode chain (offsets 49149–58219 per the catalog's own code audit). This is correct behavior per the code review in the catalog itself, which confirmed this gap via trace analysis of every `command === "..."` branch in the agent-mode dispatch logic.

## Improvement / fix suggestion

None — behaves as documented. The test case itself correctly identifies this as expected behavior. If this command *should* be available in agent-mode (which it currently is not), that would be a separate feature request, not a bug. The `/help` command (SLASH-01) correctly limits its advertised command list in agent mode and does not mention `/model`, so there is no user-facing self-contradiction here in readline mode.

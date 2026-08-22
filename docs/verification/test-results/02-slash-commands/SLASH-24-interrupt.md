# SLASH-24 — `/interrupt`

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> Command: `/interrupt`
> 
> Readline dispatch: no dispatch branch exists; also needs a genuinely in-flight turn, hard via piped stdin regardless
>
> Expected in readline: `Unknown command: /interrupt. Type /help.`

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])") && printf '/interrupt\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SLASH-24-interrupt-out.txt 2>&1
```

Session id: `9b20265c` (fresh session)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 9b20265c · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /interrupt. Type /help.
  [22m  ❯
```

## Cross-checks (if applicable)

None — this is a pure readline dispatch test with no durable side effects.

## Summary

The `/interrupt` command, when typed in readline agent mode, produced exactly the expected response: `Unknown command: /interrupt. Type /help.` The test confirms that no dispatch branch exists for this command in the agent-mode REPL, as documented in the catalog.

## Analysis

The test result matches the catalog's expectation precisely. The catalog notes that `/interrupt` "needs a genuinely in-flight turn, hard via piped stdin regardless" — meaning a true mid-turn interrupt test (one that actually stops an active computation) requires a real TTY with live user input, not a piped readline session. The test case as executed here validates the readline-level behavior: the command is not recognized as a valid agent-mode slash command, so it falls through to the generic fallback handler (`shell.ts:1482-1489`), which produces the standard `Unknown command` message. This is consistent with the catalog's finding that `/interrupt` is TUI-only in practice (where a raw keyboard interrupt can stop a live turn), with zero dispatch branch in the agent-mode readline chain.

## Improvement / fix suggestion

None — behaves as documented. The generic "Unknown command" message is appropriate for a readline-level test, since a true mid-turn interrupt requires a real PTY and cannot be meaningfully tested via piped input. The catalog's own note accurately describes this limitation.

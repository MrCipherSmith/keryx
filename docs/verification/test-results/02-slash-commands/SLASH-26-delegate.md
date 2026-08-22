# SLASH-26 — `/delegate`

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> **SLASH-26** | `/delegate` | no dispatch branch exists (confirmed: zero occurrences of the literal string `/delegate` anywhere in `shell.ts`) | Expected in readline: `Unknown command: /delegate. Type /help.` — §13's DELEG-01/02/03 rows below are **TUI-only in practice**, not readline-testable as written; revise those rows before running them

## What was actually run

```bash
printf '/delegate claude-cli "say hi"\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `b23e7987` (per-project)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession b23e7987 · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /delegate. Type /help.
  [22m  ❯
```

## Cross-checks (if applicable)

Session `b23e7987` confirmed created in per-project store and listed as the most recent session. The command `/delegate` with any arguments did not trigger any delegation-specific logic; it fell through to the generic "Unknown command" handler, as expected for a readline environment where `/delegate` is TUI-only.

## Summary

The `/delegate` slash command in readline mode correctly returns `Unknown command: /delegate. Type /help.`, exactly as expected by the catalog. The test confirms that this command has no dispatch branch in the agent-mode readline REPL and is unreachable via non-TUI input.

## Analysis

The `/delegate` command is TUI-only by design. The readline REPL does not include a dispatch branch for it — confirmed by zero occurrences in `shell.ts`. When invoked via piped stdin (readline method), the generic fallback handler at `shell.ts:1482-1489` produces the standard "Unknown command" message. This is the correct behavior for a readline environment that lacks the UI components needed to render the delegation modal and its three tabs (Work/Meta/Command).

## Improvement / fix suggestion

None — behaves as documented. This confirms the catalog's own note that `/delegate` is not readline-callable and correctly routes to TUI-only coverage for actual delegation testing (DELEG-01/02/03 remain TUI-only, as noted in the catalog itself).

# SLASH-17 — /workspace command (TUI-only)

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

| ID | Command | readline dispatch? | Expected in readline | TUI-only real behavior to check separately |
|---|---|---|---|---|
| SLASH-17 | `/workspace` | no dispatch branch; also not `describeUnavailableCommand`-eligible (that only fires for a WRONG-MODE command, and `/workspace` is `agent`-mode same as readline itself) | `Unknown command: /workspace. Type /help.` — **not** a "TUI-only" explanation despite the registry comment saying this is deliberately TUI-only | Sidebar + 3-tab modal |

## What was actually run

```bash
printf '/workspace\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `6e50b697` (per-project)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 6e50b697 · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /workspace. Type /help.
  [22m  ❯
```

## Cross-checks (if applicable)

Not applicable — the test case does not claim any durable disk effect or state change. The command rejection is immediate and visible in the transcript.

## Summary

The `/workspace` command is correctly rejected in readline agent mode with the expected message. The shell did not crash, hang, or produce any other unexpected behavior. The test behaves exactly as specified in the catalog.

## Analysis

The readline dispatch chain in `shell.ts` has no handler for `/workspace`, so the generic fallback at `shell.ts:1482-1489` correctly produces `Unknown command: /workspace. Type /help.` The catalog correctly notes that this is a TUI-only feature (sidebar + 3-tab modal), but the registry's `describeUnavailableCommand` mechanism cannot produce a TUI-specific explanation because the registry's modes dimension is chat-vs-agent, not TUI-vs-readline. This explains why a user sees a generic "Unknown command" rather than a more informative "This command is only available in the TUI" message.

## Improvement / fix suggestion

None — behaves as documented. The catalog correctly identifies this as a limitation of the registry's encoding scheme (no TUI-vs-readline dimension), not a bug in the shell itself. The rejection message is accurate for readline mode.

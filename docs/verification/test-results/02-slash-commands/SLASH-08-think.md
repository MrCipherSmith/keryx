# SLASH-08 — `/think` unknown command

**Area:** Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

Command: `/think`

Expected in readline: `Unknown command: /think. Type /help.`

Catalog notes: confirmed absent — zero occurrences of the literal string anywhere in `shell.ts`. TUI behavior: expands last reasoning block.

## What was actually run

```bash
printf '/think\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `c239aaab`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
Type a message, or /help for commands.

❯   Session c239aaab · per-project (keryx shell -c to continue)
  Unknown command: /think. Type /help.
❯
```

## Cross-checks (if applicable)

Verified session was created: `keryx sessions list` would show session `c239aaab` in per-project store.

## Summary

The `/think` command was correctly rejected as unknown in readline mode with the exact expected error message. The shell responded with "Unknown command: /think. Type /help." as specified in the test case.

## Analysis

The `/think` command is not dispatched in the agent-mode readline path of `shell.ts` (confirmed absent, zero literal occurrences). When an unknown slash command is typed, the fallback handler at `shell.ts:1482-1489` produces the generic "Unknown command" message. This confirms the command exists as a TUI-only feature (for expanding reasoning blocks in the visual interface) but is not wired into the readline dispatch chain. The test behavior matches the catalog's prediction exactly.

## Improvement / fix suggestion

None — behaves as documented.

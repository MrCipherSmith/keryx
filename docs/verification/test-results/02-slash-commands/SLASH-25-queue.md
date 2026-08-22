# SLASH-25 — /queue

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> | SLASH-25 | `/queue` | no dispatch branch exists | `Unknown command: /queue. Type /help.` | Same |

The test verifies that `/queue` (which has no dispatch branch in the agent-mode readline REPL) produces the generic "Unknown command" message when called in readline mode with `--no-tui`.

## What was actually run

```bash
printf '/queue remove 1\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `934a832f`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 934a832f · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /queue. Type /help.
  [22m  ❯ 
```

## Cross-checks (if applicable)

N/A — the test expects a textual response only; no on-disk state change is claimed.

## Summary

The `/queue remove 1` command was rejected with the expected generic "Unknown command: /queue. Type /help." message. This confirms that `/queue` has no dispatch branch in the agent-mode readline REPL and falls through to the default error handler at `shell.ts:1482-1489`, as documented in the catalog.

## Analysis

The behavior aligns exactly with the catalog's analysis: `/queue` is a command whose name appears in the registry but only as a TUI-only feature. Because the registry encodes only a `modes` dimension (chat vs. agent), never a TUI-vs-readline dimension, a readline call to a TUI-only command gets treated as a typo rather than receiving an informative "TUI-only" explanation. This is consistent with the documented gap for `/resume`, `/sessions`, `/workspace`, `/review`, `/mcp`, `/interrupt`, and `/delegate`.

The generic fallback message at `shell.ts:1482-1489` confirms that the command token `/queue` never enters any specific dispatch branch in the agent-mode chain (`shell.ts:49149–58219`).

## Improvement / fix suggestion

The test itself is working as designed. However, the underlying issue remains (noted in the catalog's own findings): commands that are genuinely TUI-only should surface a more informative message than the generic "Unknown command" fallback. This would require adding a TUI-vs-readline dimension to the registry's `modes` field, allowing `describeUnavailableCommand` to produce a targeted explanation like "This command is available in TUI mode only."

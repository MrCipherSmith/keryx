# SLASH-18 — `/review`

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> **ID:** SLASH-18  
> **Command:** `/review`  
> **Expected in readline:** `Unknown command: /review. Type /help.` (TUI-only, no readline dispatch branch)  
> **Registry comment:** Sidebar badge + list/detail modal with keyboard navigation (`[a]`/`[d]`-then-`[y]` shortcuts in TUI)

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")
printf '/review\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `78cec6a3`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 78cec6a3 · per-project (keryx shell -c to continue)
  [22m  [2mUnknown command: /review. Type /help.
  [22m  ❯ 
```

## Cross-checks (if applicable)

Session created and stored on disk:

```bash
keryx sessions list | head -1
```

Result shows session `78cec6a3` is the most recent, confirming the session was recorded.

## Summary

The test behaved exactly as expected. The `/review` slash command, when sent via readline to a fresh `keryx shell` session, produced the documented "Unknown command" message, confirming that `/review` has no readline dispatch branch (it is TUI-only, exercised through an interactive modal in the graphical shell, not in the line-based interface).

## Analysis

The finding aligns with the catalog's cross-reference to `src/commands/agent-commands.ts` and `src/harness/shell.ts` (lines 49149–58219). The registry marks `/review` as `agent`-mode in the catalog, but the agent-mode readline dispatch chain does not include a handler for `/review`. Instead, it falls through to the generic fallback at `shell.ts:1482-1489`, which prints the "Unknown command" message. This is the correct behavior for a TUI-only command attempted via readline — no special "TUI-only" explanation text is used (as the catalog notes, `describeUnavailableCommand` only fires when a command exists in the registry but is excluded from the *current shell mode*, which is not the case for `/review` — it's genuinely unimplemented in readline, not mode-excluded).

## Improvement / fix suggestion

None — behaves as documented. The catalog's own §2 analysis correctly identifies that `/workspace`, `/review`, and `/mcp` are TUI-only with no readline dispatch branch, and this test confirms that behavior.

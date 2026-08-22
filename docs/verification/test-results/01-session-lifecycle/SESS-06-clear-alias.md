# SESS-06 — `/clear` is an alias of `/new`

**Area:** 1. Session lifecycle · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> `/clear` is an alias of `/new` — readline: `hello` then `/clear` — Identical behavior to SESS-05 — Same

## What was actually run

```bash
printf 'hello\n/clear\nhello again\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id (first): `aa92ac72`
Session id (second, after `/clear`): `9155ecbd`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session aa92ac72 · per-project (keryx shell -c to continue)
  
  ● keryx
  Hello! What would you like to work on?

  ↑8691 ↓10 tokens

  ────────────────────────

  ❯   New session 9155ecbd (previous kept on disk)
  ❯ 
  ● keryx
  Hello! I'm ready to help with your work in the keryx project.

  What would you like to do? For example:
  • Explore or understand the codebase (graph, wiki, memory)
  • Run a workflow (health, testing, wiki enrich, flow)
  • Investigate a specific file, symbol, or dependency
  • Check project health or status

  ↑8692 ↓73 tokens

  ────────────────────────

  ❯
```

## Cross-checks (if applicable)

Confirmed via `keryx sessions list` that both sessions exist and are recorded on disk:
- Session `aa92ac72` (title: "hello", updated: 2026-08-22 08:54:55, 2 messages)
- Session `9155ecbd` (title: "hello again", updated: 2026-08-22 08:54:57, 2 messages)

Both sessions listed with correct timestamps showing creation order, older session `aa92ac72` first, then newer session `9155ecbd` created by `/clear` command.

## Summary

`/clear` behaved identically to `/new` as expected. The command created a new session (`9155ecbd`) while keeping the previous session (`aa92ac72`) intact on disk. Two distinct session ids were created during a single shell invocation, matching the documented alias behavior.

## Analysis

The output header clearly shows the state transition: the first prompt initialized session `aa92ac72`, then upon receiving `/clear`, the shell printed "New session 9155ecbd (previous kept on disk)" and continued with a fresh session. This confirms that `/clear` is functionally equivalent to `/new` — both create a new per-project session while preserving the previous session's on-disk record. The implementation correctly preserves the old session and does not discard it, as evidenced by the session listing showing both `aa92ac72` and `9155ecbd` with separate message counts and timestamps.

## Improvement / fix suggestion

None — behaves as documented.

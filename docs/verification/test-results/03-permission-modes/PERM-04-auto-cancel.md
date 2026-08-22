# PERM-04 — `/mode auto` requires explicit `yes` confirmation

**Area:** Permission modes · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> `/mode auto` requires explicit `yes` confirmation
>
> **Command:** readline: `/mode auto` then **not** `yes` (e.g. `no`)
>
> **Expected:** `Cancelled — mode unchanged.` — mode stays `ask`
>
> **Verify:** next `/mode` shows unchanged

## What was actually run

```bash
printf '/mode auto\nno\n/mode\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `b2c2826b` (per-project, fresh session)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session b2c2826b · per-project (keryx shell -c to continue)
  ⚠ auto mode skips confirmation for EVERY action, including destructive commands.
  Only credential-touching commands still ask. Type 'yes' to confirm:   Cancelled — mode unchanged.
  ❯   Permission mode: ask (no project default set)
  Usage: /mode <ask|trust|auto> [save] · /mode clear
  ❯
```

## Cross-checks (if applicable)

**Verification of the unchanged mode:**

The second `/mode` command (line 7 of output above) shows:
```
Permission mode: ask (no project default set)
```

This confirms the mode remained at `ask` after the user rejected the confirmation with `no`.

## Summary

The test behaved exactly as expected. The `/mode auto` command prompted for confirmation with a clear warning message about auto mode's implications. When the user replied with `no` (not `yes`), the shell printed "Cancelled — mode unchanged." and the subsequent `/mode` query confirmed the permission mode stayed at `ask`, unchanged.

## Analysis

The permission-mode confirmation gate works correctly:

1. **Prompt display:** The `/mode auto` command immediately displayed the confirmation prompt with a clear warning: "⚠ auto mode skips confirmation for EVERY action, including destructive commands. Only credential-touching commands still ask. Type 'yes' to confirm:"

2. **Rejection handling:** When the user sent `no` (not `yes`), the shell correctly cancelled the operation and reported "Cancelled — mode unchanged."

3. **State preservation:** The immediately-following `/mode` (with no args) confirmed that the mode had not changed from `ask`, proving the rejection was properly honored.

This behavior correctly implements a safety gate for a high-impact mode change: auto-approving all tools (including destructive commands) requires explicit affirmative confirmation, and any other input cancels the change.

## Improvement / fix suggestion

None — behaves as documented.

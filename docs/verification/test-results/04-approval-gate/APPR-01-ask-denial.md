# APPR-01 — `ask` mode: an ordinary shell_exec prompts, denies on EOF (headless)

**Area:** 4. Approval gate & shell-permission remember · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> readline, single line, a prompt that triggers `shell_exec`, no `/mode` line first
>
> Expected: `[y/N/A=always]` prompt printed, `denied` (EOF), tool result `not approved`

## What was actually run

```bash
printf 'Please run this shell command for me: echo test-approval-gate-denial-12345\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `38475ac1`

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 38475ac1 · per-project (keryx shell -c to continue)

  ● keryx
  I'll run that command for you.

  ⚙ shell_exec(command=echo test-approval-gate-denial-12345)

  memory: Flow ids are allocated per clone, not per checkout
  Run: echo test-approval-gate-denial-12345 [y/N/A=always] denied
  ✗ command not approved by the user; not executed
  The command was not executed — the approval gate denied it:

  • echo test-approval-gate-denial-12345 → not approved by the user; not executed

  This is the expected behavior when shell_exec requires explicit user approval. The command simply was not run. If you'd like it to execute, re-approve the request or switch to a permission mode that allows it.

  ↑8833 ↓84 tokens

  ────────────────────────

  ❯
```

## Cross-checks (if applicable)

Session was created fresh (no `-c` or `-r` flags), confirming headless mode behavior. The permission mode was at its default `ask` (verified separately via `/mode` command on a separate session showing "Permission mode: ask (no project default set)"). The command `echo test-approval-gate-denial-12345` is not in the `~/.local/share/keryx/permissions.json` allow list (only `keryx *`, `gh *`, `ls *`, and specific git/health/review/test commands are pre-approved).

## Summary

The test behaved exactly as expected. When `shell_exec` is called in default `ask` mode (headless, with EOF on stdin), the approval prompt `[y/N/A=always]` appeared, and EOF caused the approval to be denied. The tool result correctly reported "command not approved by the user; not executed".

## Analysis

The behavior demonstrates the correct functioning of the approval gate in ask mode under headless/piped input:

1. **Prompt appeared correctly**: The approval prompt `[y/N/A=always]` was printed to the user
2. **EOF denial worked**: When stdin reached EOF (no human to answer the prompt), the approval was denied
3. **Tool result was correct**: The result explicitly stated "not approved by the user; not executed", which is the documented behavior for denied approvals
4. **Permission mode was correct**: The default permission mode was "ask", requiring explicit approval for shell commands not in the pre-approved list

This confirms that the approval gate correctly blocks execution of unapproved shell commands in headless ask mode, which is a critical security feature of the harness.

## Improvement / fix suggestion

None — behaves as documented.

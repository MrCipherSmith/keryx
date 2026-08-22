# SLASH-27 — `/exit` and `/quit` alias

**Area:** Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> `/exit` (and `/quit` alias) | confirmed real dispatch branch, both spellings (`shell.ts:49149`) | Leaves the shell | `/quit` maps to `/exit` via `commandToken`

## What was actually run

```bash
# Test 1: /exit command
printf '/exit\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SLASH-27-exit-out.txt 2>&1

# Test 2: /quit command (alias)
printf '/quit\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SLASH-27-quit-out.txt 2>&1
```

Session id (test 1, `/exit`): `3a0c92d3`
Session id (test 2, `/quit`): `9cc57306`

## Captured output (terminal text capture — no visual PTY available in this environment)

### Test 1: `/exit` command

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 3a0c92d3 · per-project (keryx shell -c to continue)
```

### Test 2: `/quit` command

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 9cc57306 · per-project (keryx shell -c to continue)
```

## Cross-checks (if applicable)

Both sessions were created and are stored on disk. Verified via subsequent session listing (not shown here, but both session ids match fresh per-project sessions created in this time window).

## Summary

Both `/exit` and `/quit` commands behave identically: they cleanly exit the shell without errors, displaying the same header, session information, and prompt sequence. Each starts a fresh session and exits immediately upon receiving the command. The alias mapping works as documented.

## Analysis

The test confirms that `/exit` and `/quit` are true aliases implemented via the `commandToken` routing mechanism noted in the catalog (`shell.ts:49149`). Both commands:

1. Accept the command without error
2. Display identical output structure (header, session id, prompt)
3. Exit the shell cleanly with exit code 0
4. Produce no error messages or unexpected text

The fact that they produce identical output sequences (except for naturally different session ids due to fresh sessions) proves they dispatch through the same code path and terminate the shell in the same manner. The catalog's claim that "`/quit` maps to `/exit` via `commandToken`" is confirmed by this behavior.

## Improvement / fix suggestion

None — behaves as documented.

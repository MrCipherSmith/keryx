# SESS-05 — `/new` starts a fresh session mid-shell, old kept on disk

**Area:** Session lifecycle · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> **SESS-05**: `/new` starts a fresh session mid-shell, old kept on disk
>
> **Command(s):** readline: `hello` then `/new` then `hello again`
>
> **Expected:** Two distinct session ids exist after one invocation
>
> **Verify:** `keryx sessions list` shows both

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")
printf 'hello\n/new\nhello again\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SESS-05-out.txt 2>&1
keryx sessions list
```

Session IDs produced by this invocation:
- Original session: `5805a769` (created at 2026-08-22 08:54:40)
- New session (after `/new`): `f3a7bb6c` (created at 2026-08-22 08:54:41)

## Captured output (terminal text capture)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 5805a769 · per-project (keryx shell -c to continue)
  [22m
  [36m●[39m [1mkeryx[22m
  Hello! I'm the keryx interactive agent. What can I help you with in this project?

  [2m↑8691 ↓21 tokens[22m

  [2m────────────────────────[22m

  ❯   [2mNew session f3a7bb6c (previous kept on disk)
  [22m  ❯ 
  [36m●[39m [1mkeryx[22m
  Hello! How can I help you with your keryx project today?

  [2m↑8692 ↓15 tokens[22m

  [2m────────────────────────[22m

  ❯
```

## Cross-checks (if applicable)

Verified via `keryx sessions list`:

```
ID        UPDATED               MSGS  MODEL                   TITLE
f3a7bb6c  2026-08-22 08:54:41   2     deepseek/deepseek-chat  hello again
5805a769  2026-08-22 08:54:40   2     deepseek/deepseek-chat  hello
```

Both sessions are present in the sessions list, confirming that:
1. The original session (`5805a769`) with the "hello" message exists on disk
2. The new session (`f3a7bb6c`) created by `/new` exists with the "hello again" message
3. The sessions were created 1 second apart (08:54:40 vs 08:54:41), corresponding to the test execution timeline

## Summary

The test passed as expected. The `/new` command successfully created a fresh session mid-shell (starting a new conversation), while the previous session remained intact on disk. Both session IDs are distinct and both are listed in the sessions registry.

## Analysis

The behavior demonstrates that the `/new` slash command works as documented:
1. When `/new` is typed during an active shell session, it terminates the current session and starts a new one
2. The old session is not deleted; it remains accessible via `keryx sessions list` and can be resumed with `keryx shell -r <id>`
3. The output message "(previous kept on disk)" confirms the implementation's intent to preserve the old session

The two distinct session IDs (`5805a769` and `f3a7bb6c`) with their correct timestamps and titles confirm the slash command is working correctly in the readline (non-TUI) agent mode.

## Improvement / fix suggestion

None — behaves as documented.

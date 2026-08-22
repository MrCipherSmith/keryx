# SLASH-23 — `/clear` creates a fresh session (alias of `/new`)

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> | SLASH-23 | `/clear` | confirmed real dispatch branch (grouped with `/new`, `shell.ts:50989`) | Alias of `/new` | Same |
>
> Section reference: SESS-06 defines the expected behavior — `/clear` should produce identical behavior to `/new`, starting a fresh session mid-shell.

## What was actually run

```bash
printf 'hello\n/clear\nhi again\n' | DEEPSEEK_API_KEY="<redacted>" keryx shell --no-tui --provider deepseek
```

Session ids created:
- First session: `569e277d`
- Second session (via `/clear`): `a0bfce6c`

## Captured output (terminal text capture)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 569e277d · per-project (keryx shell -c to continue)
  [22m
  [36m●[39m [1mkeryx[22m
  Hello! What would you like to work on?

  [2m↑8691 ↓10 tokens[22m

  [2m────────────────────────[22m

  ❯   [2mNew session a0bfce6c (previous kept on disk)
  [22m  ❯ 
  [36m●[39m [1mkeryx[22m
  Hello! Ready to help. What would you like to do?

  [2m↑8692 ↓13 tokens[22m

  [2m────────────────────────[22m

  ❯
```

## Cross-checks

**Session persistence check:**

```bash
keryx sessions list | grep -E '(569e277d|a0bfce6c)'
```

Output:
```text
a0bfce6c  2026-08-22 09:01:31   2     deepseek/deepseek-chat  hi again
569e277d  2026-08-22 09:01:30   2     deepseek/deepseek-chat  hello
```

Both sessions exist on disk with the correct creation times:
- `569e277d` (first session) created at 09:01:30, contains "hello" prompt
- `a0bfce6c` (second session) created at 09:01:31, contains "hi again" prompt
- Sessions are listed newest-first, showing `a0bfce6c` first (created 1 second later)

**Verification of distinct session behavior:**

The output clearly shows:
1. Line 4: Initial session header printed: `Session 569e277d · per-project`
2. Line 13: `/clear` command executed, showing: `New session a0bfce6c (previous kept on disk)`
3. Two distinct session ids present in the output

This matches the documented behavior of `/new` and confirms `/clear` is functionally identical.

## Summary

The `/clear` command behaves identically to `/new`: it creates a new session mid-shell while keeping the previous session on disk. Two distinct sessions (`569e277d` and `a0bfce6c`) were created, each with separate message contexts, and both are persistent in the session store.

## Analysis

The test confirms the documented behavior in the catalog row and SESS-06. The `/clear` command:

1. **Creates a new session** — The shell header prints "New session a0bfce6c" immediately after `/clear` is entered
2. **Preserves the old session** — The message "(previous kept on disk)" confirms the first session is preserved
3. **Maintains distinct contexts** — Each session captures its own prompt ("hello" vs "hi again") and response from the model, as shown in the session titles in `keryx sessions list`
4. **Is dispatch-confirmed real** — The dispatch branch at `shell.ts:50989` (grouped with `/new`) executed successfully

The token counts (`↑8691 ↓10` for the first turn, `↑8692 ↓13` for the second) indicate independent turns in separate sessions, not a continuation of the same context.

## Improvement / fix suggestion

None — behaves as documented. The `/clear` command is working correctly and is a proper alias of `/new` as specified in the test catalog.

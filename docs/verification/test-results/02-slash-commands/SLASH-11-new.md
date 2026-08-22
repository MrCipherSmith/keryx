# SLASH-11 — /new

**Area:** 2. Slash commands (full registry sweep) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

This test is mapped to SESS-05 (Session lifecycle §1): `/new` starts a fresh session mid-shell, old kept on disk.

> Command (readline): `hello` then `/new` then `hello again`
> 
> Expected: Two distinct session ids exist after one invocation
> 
> Verify: `keryx sessions list` shows both

## What was actually run

```bash
printf 'hello\n/new\nhello again\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session ids: `71eb4e79` (first session) and `6c59e1bf` (second session, created by `/new`)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 71eb4e79 · per-project (keryx shell -c to continue)
  ● keryx
  Hello! How can I help you with the keryx project today?

  ↑8691 ↓15 tokens

  ────────────────────────

  ❯   New session 6c59e1bf (previous kept on disk)
  ❯ 
  ● keryx
  Hello! Let me check the current state of the project.

  ⚙ get_cwd()
  ↳ /Users/tsaitler.aleksandr/goodea/keryx

  ⚙ slate_read()
  ↳ { · +5 more (/expand)

  ⚙ flow_status()
  ↳ Flows (185): · +185 more (/expand)
  Hello. I see two in-progress flows (188, 189), but no bound Course for this session. There's no specific task queued for me yet.

  What would you like me to do?

  ↑15335 ↓43 tokens

  ────────────────────────

  ❯
```

## Cross-checks (if applicable)

**Verification via `keryx sessions list`:**

Both sessions are listed in the session store:

- `71eb4e79` — 2026-08-22 08:53:32 · 2 msgs · `deepseek/deepseek-chat` · Title: "hello"
- `6c59e1bf` — 2026-08-22 08:53:36 · 6 msgs · `deepseek/deepseek-chat` · Title: "hello again"

Both sessions were created within 4 seconds of each other (08:53:32 and 08:53:36) during the same single shell invocation, confirming they were generated from one command pipeline, not two separate invocations.

## Summary

The `/new` command successfully created a fresh session mid-shell while keeping the previous session on disk. Two distinct session ids (`71eb4e79` and `6c59e1bf`) were created and are both present in the session store, exactly as expected. The model continued conversation in the new session ("hello again") without losing the first session.

## Analysis

The test confirms that `/new` works exactly as documented in the catalog:

1. **First session (`71eb4e79`)** was created when the shell started and received the input "hello". The model responded with a greeting.

2. **`/new` command** was processed correctly by the readline dispatcher, producing the message: "New session 6c59e1bf (previous kept on disk)". The output explicitly confirms the old session was preserved.

3. **Second session (`6c59e1bf`)** was initialized fresh, starting its own model interaction. The new session executed its first turn ("hello again"), calling tools (`get_cwd`, `slate_read`, `flow_status`) as expected for a fresh agent session.

4. **Session store verification** confirms both sessions exist on disk with distinct IDs, creation timestamps 4 seconds apart, and appropriate message counts (2 in the first, 6 in the second — the second session's tools generated more messages).

This behavior matches the documented behavior from the catalog and confirms the slash command dispatch handler at `shell.ts:50989` is working correctly for the `/new` command.

## Improvement / fix suggestion

None — behaves as documented.

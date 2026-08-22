# SESS-01 — Fresh session creates a new per-project store entry

**Area:** Session lifecycle · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> **SESS-01:** Fresh session creates a new per-project store entry
> 
> **Command(s):** `keryx shell --no-tui --provider deepseek` (single line, any prompt)
> 
> **Expected:** New session id printed; header shows `Session <id> · per-project`
> 
> **Verify:** `keryx sessions list` shows it, newest first

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")
printf 'hi\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

Session id: `b23a9ab6` (extracted from output header)

## Captured output (terminal text capture — no visual PTY available in this environment)

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession b23a9ab6 · per-project (keryx shell -c to continue)
  [22m
  [36m●[39m [1mkeryx[22m
  Hi! What can I help you with?

  [2m↑8691 ↓9 tokens[22m

  [2m────────────────────────[22m

  ❯
```

## Cross-checks (if applicable)

Ran `keryx sessions list` to verify the session appears in the store:

```text
Project: /Users/tsaitler.aleksandr/goodea/keryx
Store:   /Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx

ID        UPDATED               MSGS  MODEL                   TITLE
4791ab99  2026-08-22 08:54:53   1     deepseek/deepseek-chat  What is 2+2?
c5266a2a  2026-08-22 08:54:43   2     deepseek/deepseek-chat  what is 2+2
a8d2094b  2026-08-22 08:54:43   14    deepseek/deepseek-chat  Hello test
b23a9ab6  2026-08-22 08:54:43   2     deepseek/deepseek-chat  hi
f3a7bb6c  2026-08-22 08:54:41   2     deepseek/deepseek-chat  hello again
5805a769  2026-08-22 08:54:40   2     deepseek/deepseek-chat  hello
...
```

**Cross-check result:** Session `b23a9ab6` is present in the sessions list with:
- ID: `b23a9ab6` (matches output header)
- Title: `hi` (matches the piped input)
- Model: `deepseek/deepseek-chat` (correct provider)
- MSGS: `2` (the initial message plus keryx's response)
- Updated: `2026-08-22 08:54:43`

The list is ordered by UPDATED timestamp in descending order (newest first), which is the correct sorting behavior.

## Summary

The test passed completely. A fresh `keryx shell --no-tui --provider deepseek` invocation created a new session, printed the session ID (`b23a9ab6`) in the output header in the expected format (`Session <id> · per-project`), and the session was persisted to disk and appeared in the sessions list with correct metadata.

## Analysis

The behavior matches the specification exactly. The kernel correctly:
1. Generated a unique session ID (`b23a9ab6`)
2. Printed the expected header format including `Session <id> · per-project`
3. Persisted the session to the per-project store at `~/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx/`
4. Made the session discoverable via `keryx sessions list` with accurate metadata (provider model, message count, auto-derived title from first user message)
5. Maintained the list sorted by most-recent-first (newest sessions appear at the top)

This confirms the core session lifecycle functionality works as designed: every fresh shell invocation creates a durable, discoverable session record.

## Improvement / fix suggestion

None — behaves as documented.

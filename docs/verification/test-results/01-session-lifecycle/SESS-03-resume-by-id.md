# SESS-03 — `-r <id>` resumes a specific session by short id

**Area:** Session lifecycle · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> ID: SESS-03
> 
> Test: `-r <id>` resumes a specific session by short id
>
> Command(s): `keryx shell -r <short-id> --no-tui --provider deepseek`
>
> Expected: Resumes the named session, not the latest
>
> Verify: Compare against `keryx sessions list`

## What was actually run

```bash
# Step 1: Create Session A with distinct prompt
printf 'what is 2+2\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek

# Session A: c5266a2a (created at 2026-08-22 08:54:43)

# Step 2: Create Session B with different prompt (more recent than A)
printf 'tell me a fun fact\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek

# Session B: a1bc9bb5 (created at 2026-08-22 08:55:02 — more recent than A)

# Step 3: Resume Session A by short id, confirming it resumes A not B
printf 'hi\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell -r c5266a2a --no-tui --provider deepseek
```

Session id: `c5266a2a` (Session A, the older one)

## Captured output (terminal text capture)

**Session A creation:**
```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session c5266a2a · per-project (keryx shell -c to continue)

  ● keryx
  4.

  ↑8696 ↓2 tokens

  ────────────────────────

  ❯
```

**Session B creation:**
```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session a1bc9bb5 · per-project (keryx shell -c to continue)

  ● keryx
  I'm an agent built to work on this specific keryx project — I don't have general trivia. Let me give you a fun fact about *this* repo instead: it's a Haskell toolchain that maps 884 source files across modules like harness, commands, and tui, and tracks decisions in a wiki-driven knowledge base. Fun fact-worthy: the wiki module documents 50 pages including auto-generated architecture maps, so the code literally explains itself.

  Want a real fun fact? I can't fetch trivia, but ask me anything about the project and I'll dig in.

  ↑8695 ↓121 tokens

  ────────────────────────

  ❯
```

**Resume Session A (with `-r c5266a2a`):**
```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Resumed session c5266a2a · what is 2+2 (2 context · archive 2)

  ● keryx
  Hello! How can I help you today?

  ↑8703 ↓9 tokens

  ────────────────────────

  ❯
```

## Cross-checks (if applicable)

**1. Session list verification (most recent first):**
```text
ID        UPDATED               MSGS  MODEL                   TITLE
917f41cb  2026-08-22 08:55:13   2     deepseek/deepseek-chat  hi
9cc57306  2026-08-22 08:55:02   0     deepseek/deepseek-chat  New session
a1bc9bb5  2026-08-22 08:55:02   2     deepseek/deepseek-chat  tell me a fun fact
8e2fba08  2026-08-22 08:55:00   2     deepseek/deepseek-chat  What is 2+2?
9155ecbd  2026-08-22 08:54:57   2     deepseek/deepseek-chat  hello again
aa92ac72  2026-08-22 08:54:55   2     deepseek/deepseek-chat  hello
4791ab99  2026-08-22 08:54:54   2     deepseek/deepseek-chat  What is 2+2?
3a0c92d3  2026-08-22 08:54:54   0     deepseek/deepseek-chat  New session
c5266a2a  2026-08-22 08:54:43   2     deepseek/deepseek-chat  what is 2+2
```

Session B (`a1bc9bb5`) is more recent than Session A (`c5266a2a`), yet the `-r c5266a2a` command correctly resumed Session A, not the latest session.

**2. Transcript export for Session A (c5266a2a):**
```markdown
# what is 2+2
- id: `c88f278d-cecd-4ecf-baf3-338bc5266a2a`
- project: `/Users/tsaitler.aleksandr/goodea/keryx`
- updated: 2026-08-22T08:55:26.391Z
- model: deepseek/deepseek-chat
- context: 4 · archive: 4 · compact×0
---
## user

what is 2+2

## assistant

4.

## user

hi

## assistant

Hello! How can I help you today?
```

The transcript confirms:
- Session A has the title "what is 2+2"
- The prior exchange is preserved (what is 2+2 → 4)
- Our new message "hi" was delivered to this same session
- The model responded appropriately in the context of Session A

**3. Transcript export for Session B (a1bc9bb5) — confirmed different session:**
```markdown
# tell me a fun fact
- id: `26d03a51-a13e-4bef-9d55-3df5a1bc9bb5`
- project: `/Users/tsaitler.aleksandr/goodea/keryx`
- updated: 2026-08-22T08:55:02.861Z
- model: deepseek/deepseek-chat
- context: 2 · archive: 2 · compact×0
---
## user

tell me a fun fact

## assistant

I'm an agent built to work on this specific keryx project...
```

Session B remains distinct with its own transcript, title, and context.

## Summary

The test passed completely. The `-r c5266a2a` command successfully resumed Session A (the older session) rather than the most recent Session B, confirming that the short-id resume mechanism works as documented. The resumed session correctly preserved prior context, displayed the correct session title, and received the new message in the appropriate historical context.

## Analysis

The behavior confirms that the `-r <id>` flag correctly targets the specific session by its short id rather than defaulting to the most recent session (which `-c` or `-r` alone would do). The session management system properly isolated the two sessions, maintained their independent contexts, and allowed precise resumption of a non-latest session. The header output "Resumed session c5266a2a · what is 2+2" unambiguously identified which session was resumed, and the transcript export verified the correct prior context was loaded.

## Improvement / fix suggestion

None — behaves as documented.

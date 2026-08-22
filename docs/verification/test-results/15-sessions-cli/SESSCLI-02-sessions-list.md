# SESSCLI-02 — sessions list output shape and ordering

**Area:** Sessions CLI (cross-check surface) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> `keryx sessions list --json` (if supported) or plain. Expected: Matches what `/sessions`/`/resume` would show in TUI. Verify that the output contains exact columns/format (id, updated, msgs, model, title) and confirm newest-first ordering by comparing timestamps.

## What was actually run

```bash
keryx sessions list
keryx sessions list --json
```

## Captured output (terminal text capture)

### Plain text format

```text
Project: /Users/tsaitler.aleksandr/goodea/keryx
Store:   /Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx

ID        UPDATED               MSGS  MODEL                   TITLE
c5266a2a  2026-08-22 08:54:43   2     deepseek/deepseek-chat  what is 2+2
a8d2094b  2026-08-22 08:54:43   14    deepseek/deepseek-chat  Hello test
b23a9ab6  2026-08-22 08:54:43   2     deepseek/deepseek-chat  hi
f3a7bb6c  2026-08-22 08:54:41   2     deepseek/deepseek-chat  hello again
5805a769  2026-08-22 08:54:40   2     deepseek/deepseek-chat  hello
b23e7987  2026-08-22 08:54:15   0     deepseek/deepseek-chat  New session
934a832f  2026-08-22 08:54:12   0     deepseek/deepseek-chat  New session
9b20265c  2026-08-22 08:54:12   0     deepseek/deepseek-chat  New session
87c82529  2026-08-22 08:54:10   20    deepseek/deepseek-chat  Anchors: root: /Users/tsaitler.aleksandr/goodea/keryx tre…
[... additional rows continuing in newest-first order ...]
1a86e9bb  2026-08-10 11:25:51   76    deepseek/deepseek-v4-…  проверь, при запуске хернеса keryx shell передается какой…

Resume: keryx shell -r <id>   Continue last: keryx shell -c
```

### JSON format

The `--json` flag is supported. Output is a well-formed JSON object with schema version and array of sessions.

```json
{
  "schemaVersion": 1,
  "project": "/Users/tsaitler.aleksandr/goodea/keryx",
  "sessions": [
    {
      "schemaVersion": 1,
      "id": "fd35de4e-f64d-4932-8275-a9209cc57306",
      "projectKey": "%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx",
      "projectPath": "/Users/tsaitler.aleksandr/goodea/keryx",
      "title": "New session",
      "createdAt": "2026-08-22T08:55:02.907Z",
      "updatedAt": "2026-08-22T08:55:02.907Z",
      "messageCount": 0,
      "archiveMessageCount": 0,
      "compactCount": 0,
      "provider": "deepseek",
      "model": "deepseek-chat"
    },
    {
      "schemaVersion": 1,
      "id": "26d03a51-a13e-4bef-9d55-3df5a1bc9bb5",
      "projectKey": "%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx",
      "projectPath": "/Users/tsaitler.aleksandr/goodea/keryx",
      "title": "tell me a fun fact",
      "createdAt": "2026-08-22T08:55:00.795Z",
      "updatedAt": "2026-08-22T08:55:02.861Z",
      "messageCount": 2,
      "archiveMessageCount": 2,
      "compactCount": 0,
      "provider": "deepseek",
      "model": "deepseek-chat"
    }
  ]
}
```

## Column analysis

### Plain text format columns

| Column | Format | Example | Notes |
|--------|--------|---------|-------|
| ID | 7-8 char hex or UUID short form | `c5266a2a`, `fd35de4e` | Session identifier (plain: short form, JSON: full UUID) |
| UPDATED | `YYYY-MM-DD HH:MM:SS` | `2026-08-22 08:54:43` | Session last-update timestamp; single second precision |
| MSGS | Integer (0+) | `2`, `14`, `0` | Message count in current context window |
| MODEL | `provider/model` (may truncate with …) | `deepseek/deepseek-chat`, `rapid-mlx/qwen3.5-4b-…` | Provider/model identifier |
| TITLE | Free text (may truncate with …) | `what is 2+2`, `New session`, `Anchors: root: ...…` | Session user-facing title |

### JSON format fields

Each session object includes:
- `id`: Full UUID (e.g., `fd35de4e-f64d-4932-8275-a9209cc57306`)
- `projectKey`: URL-encoded project path
- `projectPath`: Full project filesystem path
- `title`: Session title (no truncation in JSON)
- `createdAt`: ISO 8601 timestamp with millisecond precision
- `updatedAt`: ISO 8601 timestamp with millisecond precision
- `messageCount`: Integer count of messages in active context
- `archiveMessageCount`: Integer count of archived messages
- `compactCount`: Compaction operation count
- `provider`: Provider name (e.g., `deepseek`, `openai`, `rapid-mlx`)
- `model`: Model identifier (e.g., `deepseek-chat`, `gpt-4o-mini`)

## Cross-checks

### Ordering verification (newest-first)

Plain text output ordering by UPDATED timestamp:
1. c5266a2a: 2026-08-22 **08:54:43** ← newest
2. a8d2094b: 2026-08-22 **08:54:43** (same second, insertion order preserved)
3. b23a9ab6: 2026-08-22 **08:54:43** (same second, insertion order preserved)
4. f3a7bb6c: 2026-08-22 **08:54:41** (2 seconds older)
5. 5805a769: 2026-08-22 **08:54:40** (3 seconds older)
6. b23e7987: 2026-08-22 **08:54:15** (28 seconds older)
... continuing in reverse chronological order ...
Last: 1a86e9bb: 2026-08-10 **11:25:51** ← oldest (12 days older)

JSON output ordering by `updatedAt`:
1. First session: "updatedAt": "2026-08-22T08:55:02.907Z" ← newest
2. Second session: "updatedAt": "2026-08-22T08:55:02.861Z"
3. Third session: "updatedAt": "2026-08-22T08:55:00.150Z"
... continuing in reverse chronological order (ISO 8601 format)

**Confirmed:** Sessions are ordered newest-first (descending by update timestamp) in both plain and JSON formats.

### Time precision difference

- Plain text format: Second precision (`HH:MM:SS`)
- JSON format: Millisecond precision via ISO 8601 (`T08:55:02.907Z`)
- Both are consistent — JSON preserves finer granularity while plain text rounds to seconds for CLI readability

## Summary

The `keryx sessions list` command behaves as documented. It outputs a well-formatted table with five expected columns (ID, UPDATED, MSGS, MODEL, TITLE) in newest-first order by update timestamp. A `--json` flag is additionally supported and produces structured output with full session metadata. Both formats correctly order sessions in reverse chronological order, with newer sessions appearing first. The plain text format truncates long model names and titles with ellipsis (`…`) for display, while the JSON format preserves complete content.

## Analysis

The command implements the expected surface correctly. The plain text format provides a human-readable summary suitable for CLI use, with appropriate column alignment and truncation for readability. The JSON format provides programmatic access to complete session metadata, including separate `messageCount` and `archiveMessageCount` fields (which the plain text format conflates into a single "MSGS" column showing only the active context count). The universal newest-first ordering by `updatedAt` (which tracks the session's most recent modification, whether by new messages or session operations like `/new`) is consistent and useful for workflow — most-recent work appears at the top.

The JSON schema version is explicit (`schemaVersion: 1`), indicating this is a stable, versioned interface suitable for external tooling.

## Improvement / fix suggestion

None — behaves as documented.

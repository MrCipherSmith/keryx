# SESS-08 — `keryx sessions export <id>` produces readable Markdown transcript

**Area:** Session lifecycle · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

| ID | Test | Command(s) | Expected | Verify |
|---|---|---|---|---|
| SESS-08 | `keryx sessions export <id>` produces a readable Markdown transcript | `keryx sessions export <id>` | Well-formed Markdown, matches `transcript.jsonl` content | Manual diff against raw JSONL |

## What was actually run

```bash
DS_KEY=$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")
printf 'What is 2+2?\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/SESS-08-out.txt 2>&1
keryx sessions export 4791ab99 > /tmp/SESS-08-export.md 2>&1
```

Session id: `4791ab99` (short id; full id: `28dd29e7-e99c-4e25-87ce-1c994791ab99`)

## Captured output (terminal text capture — no visual PTY available in this environment)

### Shell session output (showing session id extraction):

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 4791ab99 · per-project (keryx shell -c to continue)
  
  ●   keryx
  4.

  ↑8697 ↓2 tokens

  ────────────────────────

  ❯
```

### Exported Markdown (full content):

```markdown
# What is 2+2?
- id: `28dd29e7-e99c-4e25-87ce-1c994791ab99`
- project: `/Users/tsaitler.aleksandr/goodea/keryx`
- updated: 2026-08-22T08:54:54.441Z
- model: deepseek/deepseek-chat
- context: 2 · archive: 2 · compact×0
---
## user

What is 2+2?

## assistant

4.

```

## Cross-checks (if applicable)

### Raw transcript.jsonl content:

```json
{"role":"user","content":"What is 2+2?","ts":"2026-08-22T08:54:54.441Z","kind":"message","provenance":"project"}
{"role":"assistant","content":"4.","ts":"2026-08-22T08:54:54.441Z","kind":"message","provenance":"model"}
```

### Verification mapping (Markdown ↔ JSONL):

- **Markdown title** (`# What is 2+2?`) ← matches first JSONL entry's `content` field
- **Session id** (`28dd29e7-e99c-4e25-87ce-1c994791ab99`) ← from session directory name
- **Project path** (`/Users/tsaitler.aleksandr/goodea/keryx`) ← from `summary.json` `projectPath`
- **Timestamp** (`2026-08-22T08:54:54.441Z`) ← matches both JSONL entries' `ts` field
- **Model** (`deepseek/deepseek-chat`) ← from `summary.json` `provider:model`
- **Context: 2** ← matches `summary.json` `messageCount: 2`
- **Archive: 2** ← matches `summary.json` `archiveMessageCount: 2`
- **Compact: 0** ← matches `summary.json` `compactCount: 0`
- **## user section** ← first JSONL entry with `role: "user"`, content: "What is 2+2?"
- **## assistant section** ← second JSONL entry with `role: "assistant"`, content: "4."

### Additional files cross-checked:

- `/Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx/28dd29e7-e99c-4e25-87ce-1c994791ab99/context.jsonl` — identical to transcript.jsonl (expected; only one round)
- `/Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx/28dd29e7-e99c-4e25-87ce-1c994791ab99/archive.jsonl` — identical to transcript.jsonl (expected; no compaction)
- `/Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx/28dd29e7-e99c-4e25-87ce-1c994791ab99/summary.json` — all metadata fields verified (id, projectPath, model, messageCount, archiveMessageCount, compactCount all match exported header)

## Summary

`keryx sessions export <id>` produced a well-formed, readable Markdown transcript that exactly matches the session's raw JSONL transcript content. The exported format includes proper metadata (session id, project, timestamp, model), sections for each conversational turn (organized by role), and accurate counters for context/archive/compact state. All JSONL entries map 1:1 to Markdown sections with correct role headers and content.

## Analysis

The export command correctly:

1. **Extracted session metadata** from `summary.json` (id, project path, model, timestamps, message counts)
2. **Formatted as Markdown** with a proper heading, metadata block with dashes, and role-based subsections
3. **Preserved content exactly** — the user question "What is 2+2?" and assistant response "4." appear verbatim in both the Markdown and raw JSONL
4. **Organized by role** — each JSONL entry's `role` field becomes a Markdown heading (`## user`, `## assistant`)
5. **Reflected session state** — the header correctly shows context: 2, archive: 2, compact×0, matching the `summary.json` counts

The design is clean: metadata at the top enables quick reference without parsing, role-based sections make the conversation structure immediately clear, and the Markdown is readable in any editor or viewer. The 1:1 mapping to JSONL confirms no data loss or reordering in the export.

## Improvement / fix suggestion

None — behaves as documented.

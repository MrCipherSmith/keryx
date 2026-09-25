---
type: agent-entrypoint-rule
priority: high
source: "CLAUDE.md"
version: "1.0.0"
generated_by: keryx
---

# Imported Rules: CLAUDE.md

Source: `CLAUDE.md`
Priority: `high`
Version: `1.0.0`

This file is generated from the repository root agent entrypoint. Edit `CLAUDE.md`, then rerun `keryx rules sync`.

---

# CLAUDE Instructions




## Claude-only rules

These apply to Claude sessions in this repository. They sit outside the managed
`keryx:index` block on purpose, and they are deliberately absent from `AGENTS.md`:
agents that read only `AGENTS.md` must not load them.

When writing a prompt, a subagent dispatch, a skill instruction, a stopping rule, or when
auditing existing instructions for patterns written against older models, read
`.metaproject/rules/core/opus-5-5-prompting.mdc` first.

The short form, so the common case needs no file read: Claude Opus 5.5 always reasons before
replying, so never write `think carefully`, `think step by step` or `рассуждай пошагово` — state
the completion criterion instead. Give a task its finish line rather than hand-written steps,
unless a step encodes a real ordering constraint or gate.

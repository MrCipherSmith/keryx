---
name: memory
description: Use for durable project knowledge - past decisions, constraints, known mistakes, lessons, and patterns. Search memory before planning or implementing to avoid repeating mistakes; propose durable entries after tasks.
---

# memory Skill

Use this skill for long-term project experience: accepted decisions,
constraints, known mistakes, lessons, and reusable patterns. Default search is
pure and automatic influence is accepted/current/bounded.

## Workflow

1. Before planning/implementing, run `keryx memory search "<topic>" --status accepted`.
2. Read only the returned snippets, not the whole memory.
3. Respect accepted decisions/constraints; treat `draft`/`conflict` as advisory.
4. After a task/review, propose durable entries with `keryx memory new` or `ingest`.
5. Run `keryx memory check` before relying on cross-entry links.

## Commands

```bash
keryx memory search "<query>" --status accepted
keryx memory search "<query>" --status accepted --save-report
keryx memory transition <path> --to accepted --reason "<reason>"
keryx memory supersede <old-path> --by <new-path>
keryx memory new lesson --title "<title>"
keryx memory ingest --from-review <path>
keryx memory check
```

## Notes

- Markdown is canonical. `memory index` produces an optional disposable
  catalog; runtime search scans Markdown directly and never treats the catalog
  as its source of truth.
- Default search, harness/MCP/flow/approval recall, and skill verification do
  not persist reports. `--save-report` is the explicit report action.
- Only accepted, current, scoped, bounded projections influence skills; draft,
  conflict, deprecated, superseded, expired, and future entries do not.
- Lifecycle writes use validated guarded atomic seams; init/update migration of
  legacy artifacts is advisory and never deletes files or changes Git state.

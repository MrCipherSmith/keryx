# Module src/rules

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/rules` groups 2 file(s). Depends on `src/lib`. Exposes 10 public symbol(s).

## Overview

`src/rules` is responsible for bridging a project's root agent entrypoints (files such as `AGENTS.md` and `CLAUDE.md`) and the `.metaproject/` workspace. It discovers which entrypoint files exist in a project, injects a managed metaproject-reference block into each one, mirrors their content as imported-rule documents under `.metaproject/rules/`, and — when distillation is requested — parses each entrypoint into typed sections that are filed either as focused rules, project-skill stubs, or kept verbatim in the entrypoint. The module is consumed exclusively by `src/commands`, which exposes its capabilities through the `keryx rules` CLI family.

## How it works

The module is split into two layers that build on each other. `agent-entrypoints.ts` is the lower layer: it contains the file-discovery logic that scans the project root for known entrypoint candidates (`AGENTS.md`, `CLAUDE.md`, and any manifest-provided extras), deduplicates them by resolved real path to handle symlinks, and optionally scaffolds missing defaults. It then drives the sync loop — for each existing entrypoint it calls `ensureMetaprojectReference` to insert or update the managed `<!-- keryx:index -->…<!-- /keryx:index -->` block in place, renders the file's full content as an imported-rule wrapper, and writes the result to `.metaproject/rules/<slug>.md` only when the content has actually changed (idempotent write). A companion `renderProjectRulesSkillReadme` write keeps `.metaproject/skills/project-rules/README.md` in sync.

`distill.ts` is the higher layer and calls into `agent-entrypoints.ts` as its first step. After the sync it reads each entrypoint again, strips the managed block, and feeds the remaining Markdown through a section splitter that recognises headings up to level 3. Each section is then classified by keyword signals: sections whose text mentions project-specific tokens (paths, tooling, frameworks) are filed as rules; sections that read like agent workflows or skill invocations become project-skill stubs; sections that contain personal, global, or safety language are kept in the entrypoint. Distilled rules are written to `.metaproject/rules/entrypoints/<slug>.md` with a YAML front-matter header; distilled skills are written to `.metaproject/project-skills/entrypoints/<slug>/SKILL.md` with a structured skill schema. Finally, `writeDistilledIndex` assembles a manifest at `.metaproject/rules/entrypoints/index.md` that lists every extracted rule, skill, and kept section in tabular form.

## Key concepts

- **Agent entrypoint** — a root-level Markdown file (`AGENTS.md`, `CLAUDE.md`, or a manifest-declared custom file) that an agent framework reads as its top-level instruction source.
- **Managed block** — the `<!-- keryx:index -->…<!-- /keryx:index -->` fenced region that `ensureMetaprojectReference` injects into each entrypoint. It holds a standard metaproject-bootstrap instruction and is updated in-place across re-runs without touching surrounding content.
- **Imported rule** — a wrapped copy of an entrypoint's full content stored under `.metaproject/rules/` so the metaproject index can reference it with a stable path and priority (`high`).
- **Distilled rule** (`DistilledEntry` with `kind: "rule"`) — a single Markdown heading and its body extracted from an entrypoint and written to `.metaproject/rules/entrypoints/` as a focused, self-contained rule document.
- **Distilled skill** (`DistilledEntry` with `kind: "skill"`) — a section classified as an agent workflow, written as a SKILL.md stub to `.metaproject/project-skills/entrypoints/` so the skill catalog can surface it for routing.
- **Root section** (`kind: "root"`) — a section that carries personal, global, or safety instructions; it remains in the entrypoint after distillation and is recorded in the index without being moved.
- **Idempotent write** — `writeTextIfChanged` / `writeTextIfMissing` helpers ensure that files on disk are not touched when their content would be identical, keeping downstream watchers quiet and git diffs clean.

## Main flows

**Flow 1 — Bootstrap sync (`keryx rules sync` / `syncAgentRules`)**
1. `findAgentEntrypoints` scans the project root directory listing against the candidate set and deduplicates by real path.
2. `ensureDefaultAgentEntrypoints` scaffolds `AGENTS.md` and `CLAUDE.md` if either is absent.
3. For each resolved entrypoint, `ensureMetaprojectReference` reads the file, locates the managed-block markers, and either inserts a new block near the top (after any YAML front matter and the first heading) or replaces the existing block in-place; the file is written only when content changed.
4. `ruleFileNameFor` derives a safe slug from the source file name; the file's content is wrapped by `renderImportedAgentRules` and written to `.metaproject/rules/<slug>.md` via `writeTextIfChanged`.
5. `renderProjectRulesSkillReadme` regenerates `.metaproject/skills/project-rules/README.md` listing every synced source; the function returns the `SyncedAgentRule[]` array to the caller.

**Flow 2 — Entrypoint distillation (`keryx rules distill` / `distillAgentEntrypoints`)**
1. `distillAgentEntrypoints` calls `syncAgentRules` first, reusing the full bootstrap flow above.
2. For each entrypoint, `stripManagedBlock` removes the injected block before parsing; `splitMarkdownSections` walks lines and groups content under heading boundaries.
3. `classifySection` scores each section against three keyword sets (project, skill, root) and returns a `"rule" | "skill" | "root"` verdict.
4. Rules go to `writeDistilledRule` (`.metaproject/rules/entrypoints/<slug>.md` with YAML front matter); skills go to `writeDistilledSkill` (`.metaproject/project-skills/entrypoints/<slug>/SKILL.md`); root sections are collected in `kept`.
5. `rewriteEntrypoint` writes the entrypoint back containing only the kept sections plus a fresh managed block, then calls `ensureMetaprojectReference` to guarantee the block is current.
6. `writeDistilledIndex` emits `.metaproject/rules/entrypoints/index.md` with three tables (extracted rules, extracted skills, kept sections) for agent and human inspection.

**Flow 3 — Managed block upsert (`ensureMetaprojectReference`)**
This function is called both during sync and at the tail of every distillation rewrite. It reads the target file, searches for `<!-- keryx:index -->`. If the marker is present, `replaceManagedBlock` splices the updated block between the markers and collapses excess blank lines. If absent, `insertMetaprojectBlockNearTop` skips past any YAML front matter and the document's first heading before inserting, so the bootstrap instruction appears near the top but below any title or metadata.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `SyncedAgentRule`
- `SyncAgentRulesOptions`
- `syncAgentRules` (function)
- `ensureMetaprojectReference` (function)
- `ruleFileNameFor` (function)
- `DistilledEntry`
- `DistillEntrypointsResult`
- `distillAgentEntrypoints` (function)
- `hasDistilledEntrypoints` (function)
- `listRootEntrypoints` (function)

### Key files

- `src/rules/agent-entrypoints.ts` - imported by 4, imports 3
- `src/rules/distill.ts` - imported by 3, imports 2

### Depends on

- `src/lib` - 4 import(s)

### Depended on by

- `src/commands` - 6 import(s)

### Graph signals

- Files: 2
- Cross-module imports: 4

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

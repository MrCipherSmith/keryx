---
Title: Module src/rules
Version: 1.0.2
Type: component
Status: accepted
Summary: ""
---
# Module src/rules

VerifiedAt: 7d38dba02fad6f8f81d8f244f76b08d0b2f59682
VerifiedScope: sha256:4466e5ea9737450bcbcb0782364cc55907febd60baa3e40b76d6d1f4cdd27969

## Overview

`src/rules` synchronizes project root agent entrypoints with the `.metaproject/` workspace. It performs two core functions:

1. **Sync** — Discovers entrypoint files (`AGENTS.md`, `CLAUDE.md`), injects a managed metaproject reference block, and mirrors content as imported rules.
2. **Distill** — Parses entrypoints into typed sections (rules, skills, root content) for focused reuse.

This module is consumed exclusively by `src/commands`, which exposes its capabilities through the `keryx rules` CLI family.

## Architecture

The module contains two files that build on each other:

### `agent-entrypoints.ts` — Bootstrap layer

Handles file discovery and sync operations:

- **`findAgentEntrypoints`** — Scans the project root for candidate files (`AGENTS.md`, `CLAUDE.md`, and manifest-provided extras), deduplicates by resolved real path to handle symlinks.
- **`ensureDefaultAgentEntrypoints`** — Scaffolds missing defaults when requested.
- **`ensureMetaprojectReference`** — Injects or updates the managed `<!-- keryx:index -->…<!-- /keryx:index -->` block in each entrypoint.
- **`syncAgentRules`** — Drives the full sync loop: for each entrypoint, ensures the managed block, renders content as an imported rule, and writes to `.metaproject/rules/<slug>.md` idempotently.
- **`renderProjectRulesSkillReadme`** — Keeps `.metaproject/skills/project-rules/README.md` in sync.

### `distill.ts` — Extraction layer

Builds on the bootstrap layer to classify and extract sections:

- **`distillAgentEntrypoints`** — Calls sync first, then reads each entrypoint, strips the managed block, and classifies remaining sections.
- **`splitMarkdownSections`** — Splits content by headings up to level 3.
- **`classifySection`** — Scores sections against keyword sets (project, skill, root) to determine disposition.
- **`writeDistilledRule/Skill`** — Writes extracted content to structured files with YAML front matter.
- **`writeDistilledIndex`** — Generates `.metaproject/rules/entrypoints/index.md` with tabular summaries.

## Key concepts

| Concept | Description |
|---------|-------------|
| **Agent entrypoint** | Root-level Markdown file (`AGENTS.md`, `CLAUDE.md`, or manifest-declared) that an agent framework reads as top-level instructions. |
| **Managed block** | `<!-- keryx:index -->…<!-- /keryx:index -->` region containing the metaproject bootstrap instruction. Updated in-place across re-runs without affecting surrounding content. |
| **Imported rule** | Full entrypoint content wrapped and stored at `.metaproject/rules/<slug>.md` with `high` priority for stable referencing. |
| **Distilled rule** | `DistilledEntry` with `kind: "rule"` — a heading and body extracted to `.metaproject/rules/entrypoints/<slug>.md`. |
| **Distilled skill** | `DistilledEntry` with `kind: "skill"` — a workflow section written as `SKILL.md` to `.metaproject/project-skills/entrypoints/`. |
| **Root section** | `kind: "root"` — personal, global, or safety content that remains in the entrypoint after distillation. |
| **Idempotent write** | `writeTextIfChanged` / `writeTextIfMissing` skip writes when content is unchanged, keeping watchers and git diffs clean. |

## Main flows

### Flow 1 — Bootstrap sync (`keryx rules sync`)

```
findAgentEntrypoints → ensureDefaultAgentEntrypoints → ensureMetaprojectReference → renderImportedAgentRules → writeTextIfChanged
```

1. Scan project root against candidate set; deduplicate by real path.
2. Scaffold `AGENTS.md` / `CLAUDE.md` if absent.
3. For each entrypoint, inject or update the managed block (write only if changed).
4. Render content as imported rule wrapper; write to `.metaproject/rules/<slug>.md`.
5. Regenerate `.metaproject/skills/project-rules/README.md`; return `SyncedAgentRule[]`.

### Flow 2 — Entrypoint distillation (`keryx rules distill`)

```
distillAgentEntrypoints → syncAgentRules → stripManagedBlock → splitMarkdownSections → classifySection → writeDistilled* → rewriteEntrypoint
```

1. Run full sync first (reuses Flow 1).
2. Strip managed block; split entrypoint by H1–H3 headings.
3. Classify each section: project-specific → rule, workflow-like → skill, personal/global/safety → root.
4. Write rules to `.metaproject/rules/entrypoints/<slug>.md` with YAML front matter.
5. Write skills to `.metaproject/project-skills/entrypoints/<slug>/SKILL.md` with skill schema.
6. Rewrite entrypoint containing only kept sections plus fresh managed block.
7. Emit `.metaproject/rules/entrypoints/index.md` with three tables.

### Flow 3 — Managed block upsert (`ensureMetaprojectReference`)

Handles both initial injection and subsequent updates:

- If `<!-- keryx:index -->` exists: `replaceManagedBlock` splices updated content between markers.
- If absent: `insertMetaprojectBlockNearTop` skips YAML front matter and the first heading, then inserts.
- Called during sync and after every distillation rewrite.

---

<!-- keryx:reference:begin v=1 hash=95ddff1fcd710e78a44e576dd10fe2178335c068139d7cfb6cea3d060a975f71 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `CODEX_PROJECT_DOC_MAX_BYTES`
- `AgentEntrypointsManifest`
- `ProjectEntrypoints`
- `resolveProjectEntrypoints`
- `declaredImportSources`
- `manifestAgentEntrypoints`
- `WriteEntrypointBlocksOptions`
- `writeEntrypointBlocks`
- `writeCodexLocalTargets`
- `CodexOverrideState`
- `codexOverrideState`
- `isCodexOverrideStale`
- `codexOverrideByteSize`
- `LocalLeftover`
- `planLocalLeftovers`
- `moveRulesBlocksOutOfTeamFiles`
- `RulesBlockLocalTargetGap`
- `rulesBlockLocalTargetGap`
- `rulesBlocksLeavingLocalTargets`
- `parseCodexOverrideProvenance`

### Key files

- `src/rules/entrypoint-writers.ts` - imported by 16, imports 13
- `src/rules/agent-entrypoints.ts` - imported by 11, imports 10
- `src/rules/entrypoint-targets.ts` - imported by 19, imports 0
- `src/rules/entrypoint-inspection.ts` - imported by 4, imports 11
- `src/rules/managed-index-block.ts` - imported by 10, imports 2
- `src/rules/distill.ts` - imported by 4, imports 7

### Depends on

- `src/lib` - 22 import(s)
- `src/integrations` - 4 import(s)

### Depended on by

- `src/commands` - 16 import(s)
- `src/integrations` - 12 import(s)
- `src/lib` - 2 import(s)
- `src/standard` - 1 import(s)

### Dependency basis

- Production imports only: 15 import(s) from test file(s) (e.g. `src/commands/doctor-entrypoints.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 19
- Cross-module imports: 26
<!-- keryx:reference:end -->

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.1 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

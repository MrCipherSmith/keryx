# Module src/gdskills

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/gdskills` groups 14 file(s). Depends on `src/lib`, `src/wiki`, `src/memory`. Exposes 10 public symbol(s).

## Overview

`src/gdskills` is the engine that defines, installs, verifies, exports, and continuously updates the bundled working skills that keryx deploys into every Metaproject workspace. It owns the canonical skill registry (`catalog.ts`), the full lifecycle of project-local entity skills (create → verify → learn → export), and the structured multi-agent communication contracts that orchestrators and workers rely on. The module is the primary dependency of `src/commands` (13 imports) and provides the only skill-related surface consumed by `src/health`.

## How it works

The module is organized around four cooperating concerns rather than a strict layer stack.

**Skill definition and installation.** `catalog.ts` is the authoritative registry of every bundled skill: it defines `BundledSkill` records grouped into six categories (`core`, `orchestration`, `review`, `quality`, `planning`, `platform`) and three install profiles (`minimal`, `recommended`, `full`). It also contains pure rendering functions that generate the human-readable `catalog.md`, the `gdskills.md` module manifest, and individual `SKILL.md` files from the same source of truth. `install.ts` reads from `catalog.ts` to materialize a selected profile into `.metaproject/skills/gdskills/`, copy shared skills and bundled rules, write the catalog and manifest, and install JSON Schema contracts under `.metaproject/core/gdskills/contracts/`. It preserves any manually authored project-skills section in an existing catalog across reinstalls by splicing the `<!-- gdskills:project-skills:start/end -->` block into the regenerated file.

**Verification.** `verify.ts` implements `verifyProjectSkill`, which checks whether a given project-local skill is still aligned with the codebase. It resolves the skill package via `resolveProjectSkill`, reads its `SKILL.md` metadata, then runs a battery of `VerificationSignal` checks: required file presence (`SKILL.md`, `skill-changelog.md`), metadata completeness (version, target, last-verified), registry registration, target path existence, and evidence artifact presence for gdgraph, gdctx, gdwiki, code-health, and memory. It also consults accepted project memory via `relevantAcceptedMemory` to surface any decisions that contradict the skill's assumptions. The signal set is then classified into one of four statuses (`fresh`, `needs-review`, `stale`, `blocked`) and turned into actionable recommendations. On a real run it writes a JSON report under `.metaproject/data/gdskills/reports/`, a `verification.md` summary next to `SKILL.md`, and stamps `Last Verified` in the skill metadata.

**Learning.** `learn.ts` closes the feedback loop between codebase signals and skill content. `learnProjectSkill` reads a source artifact (a review report, test failure log, health JSON, or memory entry), resolves the relevant registry entry by matching content against skill targets and paths, and extracts candidate lessons using source-type-aware keyword heuristics or JSON field extraction. It writes a `LearningProposal` JSON and Markdown under `.metaproject/data/gdskills/proposals/`. `applyLearningProposal` later takes a reviewed proposal and surgically appends bullet items to targeted sections (`Review Lessons`, `Review Checklist`, `Anti-patterns`, `Testing Rules`, `Business Rules`, `Implementation Patterns`), bumps the skill's patch version, and appends a changelog entry — all under a file lock to prevent concurrent writes.

**Export.** `export.ts` packages a project-local skill for consumption by external runtimes (`codex`, `claude`, `plugin`). For standard runtimes it copies `SKILL.md` and safe auxiliary directories (`references`, `templates`, `assets`, `scripts`) to `.metaproject/runtime/skills/<runtime>/<module>-<name>/`, excluding management-only files such as verification and proposal artifacts. The `plugin` runtime delegates to `export-plugin.ts` for a distinct package layout. All operations support a `dryRun` flag that returns a planned file list without touching the filesystem.

## Key concepts

- **BundledSkill** — the canonical record for a gdskills-native working skill, carrying name, category, install profiles, purpose, ordered workflow steps, and natural-language trigger phrases.
- **GdskillsProfile** — the install tier (`minimal`, `recommended`, `full`, `custom`) that controls which bundled skills are materialized into a workspace.
- **ProjectSkillRegistryEntry** — a manifest record for a project-local entity skill, linking a module name, skill name, file path, and target entity to enable routing, verification, and learning.
- **VerificationSignal** — an atomic check result (`pass` / `warn` / `fail`) emitted during `verifyProjectSkill`, covering file presence, metadata, registry membership, target existence, and evidence artifacts.
- **ProjectSkillVerificationStatus** — the four-state verdict derived from all signals: `fresh` (all checks pass, evidence present), `needs-review` (no prior verification or missing evidence), `stale` (non-blocking failures), `blocked` (missing required files).
- **LearningProposal** — a structured JSON artifact that captures candidate lessons extracted from a source artifact, mapped to one project skill, with confidence rating and suggested sections, before any SKILL.md is modified.
- **SkillRuntime** — the export target (`codex`, `claude`, `plugin`) that determines the output package layout.

## Main flows

**Flow 1 — Install bundled skills.** `keryx skills install --profile recommended` calls `installGdskills` in `install.ts`. It calls `getBundledSkillsForProfile("recommended")` from `catalog.ts` to get the filtered, sorted list of skills. For each skill it resolves the bundled source directory under `./bundled/skills/<category>/<name>` (with a packaged-dist fallback), copies it to `.metaproject/skills/gdskills/<category>/<name>/`, or falls back to generating a `SKILL.md` from `renderBundledSkill`. After all skills are copied it installs shared helpers, copies core rules, writes `catalog.md` via `renderGdskillsCatalog`, writes `gdskills.md` via `renderGdskillsManifest`, and installs the five JSON Schema contract files into `.metaproject/core/gdskills/contracts/`.

**Flow 2 — Verify a project skill.** `keryx skills verify auth/session-store` calls `verifyProjectSkill` in `verify.ts`. It reads the Metaproject manifest to get the registry, resolves the skill package path, parses `SKILL.md` metadata, and runs `collectVerificationSignals`. The signal collector checks required files, metadata fields, registry presence, target path, and five evidence artifact groups. It also calls `relevantAcceptedMemory` from `src/memory` to retrieve decisions that may conflict with the skill. `classifyStatus` reduces signals to a single status; `recommendationsFor` maps failing signals to actionable CLI commands. The final `ProjectSkillVerificationReport` is written to `.metaproject/data/gdskills/reports/`, a human-readable summary is written as `verification.md` beside `SKILL.md`, and the skill metadata is stamped with the current timestamp.

**Flow 3 — Learn from a review report.** `keryx skills learn --from-review <report-path>` calls `learnProjectSkill` in `learn.ts` with `sourceType: "review"`. The function reads the report file, attempts to resolve the target skill by matching file content against registry `target`, `path`, and `module/name` fields. It extracts candidate lessons via keyword heuristics (or JSON field extraction for structured reports), assigns a confidence level, and persists a `LearningProposal` JSON and Markdown. After the user reviews the proposal, `keryx skills apply <proposal-path>` calls `applyLearningProposal`, which loads the proposal under a file lock, reads the current `SKILL.md`, appends lessons to the appropriate sections, bumps the patch version, appends a changelog entry to `skill-changelog.md`, and writes an `.applied.json` marker so the proposal cannot be applied twice.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `ProjectSkillVerificationStatus`
- `VerifyProjectSkillOptions`
- `VerificationSignal`
- `ProjectSkillVerificationReport`
- `verifyProjectSkill` (function)
- `SkillRuntime`
- `ExportProjectSkillOptions`
- `ExportProjectSkillResult`
- `normalizeSkillRuntime` (function)
- `exportProjectSkill` (function)

### Key files

- `src/gdskills/verify.ts` - imported by 2, imports 5
- `src/gdskills/export.ts` - imported by 2, imports 4
- `src/gdskills/install.ts` - imported by 4, imports 2
- `src/gdskills/catalog.ts` - imported by 5, imports 0
- `src/gdskills/learn.ts` - imported by 3, imports 2
- `src/gdskills/export-plugin.ts` - imported by 2, imports 2

### Depends on

- `src/lib` - 13 import(s)
- `src/wiki` - 3 import(s)
- `src/memory` - 1 import(s)

### Depended on by

- `src/commands` - 13 import(s)
- `src/health` - 1 import(s)

### Graph signals

- Files: 14
- Cross-module imports: 17

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/wiki](src-wiki.md)
- [Module src/memory](src-memory.md)
- [Module src/commands](src-commands.md)
- [Module src/health](src-health.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.

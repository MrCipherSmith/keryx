---
Title: Module src/gdskills
Version: 1.0.2
Type: component
Status: accepted
Summary: ""
---
```markdown
---
Title: Module src/gdskills
Version: 1.0.1
Type: component
Status: accepted
Summary: "src/gdskills` groups 14 file(s). Depends on `src/lib`, `src/wiki`, `src/memory`. Exposes 10 public symbol(s)."
---
# Module src/gdskills

VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:024b9291a4f78fdb54c93f640b52d5a52094547dd479a548c763191f083ed326

## Summary

`src/gdskills` defines, installs, verifies, exports, and continuously updates the bundled working skills that keryx deploys into every Metaproject workspace. It manages the canonical skill registry, the full lifecycle of project-local entity skills (create → verify → learn → export), and the structured multi-agent communication contracts that orchestrators and workers rely on.

The module groups 14 files and exposes 10 public symbols. It is the primary dependency of `src/commands` (17 imports) and provides the only skill-related surface consumed by `src/health`.

## Overview

`src/gdskills` is organized around four cooperating concerns:

1. **Skill definition and installation** — `catalog.ts` serves as the authoritative registry for every bundled skill. It defines `BundledSkill` records grouped into six categories (`core`, `orchestration`, `review`, `quality`, `planning`, `platform`) and three install profiles (`minimal`, `recommended`, `full`). Pure rendering functions generate the human-readable `catalog.md`, the `gdskills.md` module manifest, and individual `SKILL.md` files from the same source of truth. `install.ts` materializes a selected profile into `.metaproject/skills/gdskills/`, installs shared skills and bundled rules, writes the catalog and manifest, and deploys JSON Schema contracts under `.metaproject/core/gdskills/contracts/`.

2. **Verification** — `verify.ts` checks whether a project-local skill remains aligned with the codebase. It runs `VerificationSignal` checks for required files, metadata completeness, registry registration, target path existence, and evidence artifacts. Signals are classified into `fresh`, `needs-review`, `stale`, or `blocked` status. Results are written as a JSON report, a human-readable `verification.md` summary, and a `Last Verified` stamp in skill metadata.

3. **Learning** — `learn.ts` closes the feedback loop between codebase signals and skill content. It reads source artifacts (review reports, test failure logs, health JSON, or memory entries), resolves the relevant registry entry, and extracts candidate lessons. Output is a `LearningProposal` that can be reviewed and applied to update skill sections.

4. **Export** — `export.ts` packages a project-local skill for external runtimes (`codex`, `claude`, `plugin`). It copies skill files to `.metaproject/runtime/skills/<runtime>/<module>-<name>/`, excluding management-only artifacts. All operations support a `dryRun` flag.

## How it works

### Skill installation

`install.ts` reads from `catalog.ts` to materialize a selected profile into `.metaproject/skills/gdskills/`. For each skill it:

- Resolves the bundled source under `./bundled/skills/<category>/<name>` (with a packaged-dist fallback)
- Copies the skill directory or falls back to generating `SKILL.md` from `renderBundledSkill`
- Installs shared helpers and copies core rules
- Writes `catalog.md` via `renderGdskillsCatalog`
- Writes `gdskills.md` via `renderGdskillsManifest`
- Installs JSON Schema contracts under `.metaproject/core/gdskills/contracts/`

The installer preserves any manually authored project-skills section by splicing the `<!-- gdskills:project-skills:start/end -->` block into the regenerated catalog.

### Verification

`verify.ts` implements `verifyProjectSkill`, which checks whether a given project-local skill is aligned with the codebase:

1. Resolves the skill package via `resolveProjectSkill`
2. Reads `SKILL.md` metadata
3. Runs `collectVerificationSignal` checks:
   - Required file presence (`SKILL.md`, `skill-changelog.md`)
   - Metadata completeness (version, target, last-verified)
   - Registry registration
   - Target path existence
   - Evidence artifact presence for gdgraph, gdctx, gdwiki, code-health, and memory
4. Consults accepted project memory via `relevantAcceptedMemory` to surface conflicting decisions
5. Classifies signals into `fresh`, `needs-review`, `stale`, or `blocked` status
6. Maps signals to actionable recommendations

Output is written as:
- A JSON report under `.metaproject/data/gdskills/reports/`
- A `verification.md` summary next to `SKILL.md`
- A `Last Verified` stamp in skill metadata

### Learning

`learn.ts` implements `learnProjectSkill` to extract lessons from source artifacts:

1. Reads a source artifact (review report, test failure log, health JSON, or memory entry)
2. Resolves the relevant registry entry by matching content against skill targets and paths
3. Extracts candidate lessons using source-type-aware keyword heuristics or JSON field extraction
4. Writes a `LearningProposal` JSON and Markdown under `.metaproject/data/gdskills/proposals/`

`applyLearningProposal` applies a reviewed proposal by:

1. Loading the proposal under a file lock to prevent concurrent writes
2. Reading the current `SKILL.md`
3. Appending lessons to targeted sections (`Review Lessons`, `Review Checklist`, `Anti-patterns`, `Testing Rules`, `Business Rules`, `Implementation Patterns`)
4. Bumping the skill's patch version
5. Appending a changelog entry to `skill-changelog.md`
6. Writing an `.applied.json` marker to prevent duplicate application

### Export

`export.ts` packages a project-local skill for consumption by external runtimes. For standard runtimes (`codex`, `claude`) it copies `SKILL.md` and safe auxiliary directories (`references`, `templates`, `assets`, `scripts`) to `.metaproject/runtime/skills/<runtime>/<module>-<name>/`, excluding management-only files. The `plugin` runtime delegates to `export-plugin.ts` for a distinct package layout.

All operations support a `dryRun` flag that returns a planned file list without touching the filesystem.

## Key concepts

| Concept | Description |
|---------|-------------|
| **BundledSkill** | Canonical record for a gdskills-native working skill, carrying name, category, install profiles, purpose, ordered workflow steps, and natural-language trigger phrases. |
| **GdskillsProfile** | Install tier (`minimal`, `recommended`, `full`, `custom`) controlling which bundled skills are materialized into a workspace. |
| **ProjectSkillRegistryEntry** | Manifest record for a project-local entity skill, linking module name, skill name, file path, and target entity for routing, verification, and learning. |
| **VerificationSignal** | Atomic check result (`pass` / `warn` / `fail`) emitted during verification, covering file presence, metadata, registry membership, target existence, and evidence artifacts. |
| **ProjectSkillVerificationStatus** | Four-state verdict: `fresh` (all checks pass, evidence present), `needs-review` (no prior verification or missing evidence), `stale` (non-blocking failures), `blocked` (missing required files). |
| **LearningProposal** | Structured JSON artifact capturing candidate lessons extracted from a source artifact, mapped to one project skill, with confidence rating and suggested sections. |
| **SkillRuntime** | Export target (`codex`, `claude`, `plugin`) determining the output package layout. |

## Main flows

### Flow 1 — Install bundled skills

Command: `keryx skills install --profile recommended`

1. Calls `installGdskills` in `install.ts`
2. Calls `getBundledSkillsForProfile("recommended")` from `catalog.ts` to get the filtered, sorted skill list
3. For each skill:
   - Resolves bundled source under `./bundled/skills/<category>/<name>` (or packaged-dist fallback)
   - Copies to `.metaproject/skills/gdskills/<category>/<name>/` or generates `SKILL.md` from `renderBundledSkill`
4. Installs shared helpers and copies core rules
5. Writes `catalog.md` via `renderGdskillsCatalog`
6. Writes `gdskills.md` via `renderGdskillsManifest`
7. Installs five JSON Schema contract files into `.metaproject/core/gdskills/contracts/`

### Flow 2 — Verify a project skill

Command: `keryx skills verify auth/session-store`

1. Calls `verifyProjectSkill` in `verify.ts`
2. Reads the Metaproject manifest to get the registry
3. Resolves the skill package path
4. Parses `SKILL.md` metadata
5. Runs `collectVerificationSignals`:
   - Required files, metadata fields, registry presence
   - Target path existence
   - Five evidence artifact groups
   - Calls `relevantAcceptedMemory` from `src/memory` for conflicting decisions
6. `classifyStatus` reduces signals to a single status
7. `recommendationsFor` maps failing signals to actionable CLI commands
8. Writes:
   - `ProjectSkillVerificationReport` to `.metaproject/data/gdskills/reports/`
   - Human-readable `verification.md` beside `SKILL.md`
   - `Last Verified` stamp in skill metadata

### Flow 3 — Learn from a review report

Command: `keryx skills learn --from-review <report-path>`

1. Calls `learnProjectSkill` in `learn.ts` with `sourceType: "review"`
2. Reads the report file
3. Resolves target skill by matching file content against registry `target`, `path`, and `module/name` fields
4. Extracts candidate lessons via keyword heuristics or JSON field extraction
5. Assigns a confidence level
6. Persists `LearningProposal` JSON and Markdown to `.metaproject/data/gdskills/proposals/`

After review:

Command: `keryx skills apply <proposal-path>`

1. Calls `applyLearningProposal`
2. Loads proposal under a file lock
3. Reads current `SKILL.md`
4. Appends lessons to appropriate sections
5. Bumps patch version
6. Appends changelog entry to `skill-changelog.md`
7. Writes `.applied.json` marker

---

<!-- keryx:reference:begin v=1 hash=1f10816942479fbb46ad045945b0dd2f48b846201fa7a574a3ac3a7534f93fe7 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `ContractName`
- `ContractEnforcement`
- `ContractInfo`
- `JsonSchema`
- `ValidationError`
- `ValidationResult`
- `CONTRACTS`
- `normalizeContractName` (function)
- `validateContractFile` (function)
- `validateJson` (function)
- `loadSchema` (function)
- `contractPath` (function)
- `relativeContractPath` (function)
- `BUNDLED_SKILL_CHECKS`
- `BundledSkillCheck`
- `BundledSkillFinding` (interface)
- `BundledSkillEvaluation` (interface)
- `PERSONA_PATTERNS`
- `PERSONAL_MARKER_PATTERNS`
- `HARNESS_HOME_ROOTS`

### Key files

- `src/gdskills/contracts.ts` - imported by 31, imports 0
- `src/gdskills/bundled-eval.ts` - imported by 14, imports 6
- `src/gdskills/catalog.ts` - imported by 16, imports 1
- `src/gdskills/export.ts` - imported by 10, imports 5
- `src/gdskills/project-skills.ts` - imported by 12, imports 3
- `src/gdskills/import-skills.ts` - imported by 4, imports 9

### Depends on

- `src/lib` - 19 import(s)
- `src/security` - 2 import(s)
- `src/memory` - 1 import(s)
- `src/wiki` - 1 import(s)

### Depended on by

- `src/commands` - 18 import(s)
- `src/review` - 6 import(s)
- `src/agents` - 5 import(s)
- `src/gdskills/governance` - 5 import(s)
- `src/harness/routing` - 2 import(s)
- `src/lib` - 2 import(s)

### Dependency basis

- Production imports only: 53 import(s) from test file(s) (e.g. `src/agents/compile.model-tier.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 56
- Cross-module imports: 23
<!-- keryx:reference:end -->

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

- 1.0.2 - Reference refreshed from the code graph (4e80355f).
- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
```

# TRD: project implementation rules and skills

Companion to [README.md](README.md). Line numbers are for branch base 330209bce (2026-10-17). `src/gdskills/bundled/skills/...` is the source; `.metaproject/skills/gdskills/...` is the installed copy a project runs.

## 1. Current state

| Fact | Where |
|---|---|
| Only module `review` is read by an orchestrator | `PROJECT_REVIEWER_MODULE`, `src/gdskills/project-reviewers.ts:17` |
| Other modules print "not auto-injected" | `src/gdskills/import-skills.ts:2128-2133`, `:249-252` |
| Categories accepted without `--module` | `KNOWN_CATEGORIES`, `import-skills.ts:694-700` (no `implementation`, `testing`); fallback `inferModule` `:2119-2126` |
| A rule is imported only if a skill cites it | `src/gdskills/rule-references.ts` (`ruleReferences`) |
| Project-first rule lookup exists, used by reviewers only | `resolveRuleReference`, `PROJECT_RULES_DIR`, `projectRulePath` in `rule-references.ts`; `shadowedRules` in `src/review/reviewers.ts` |
| `keryx init/update` overwrite only `rules/core/` | `rule-references.ts`; reviewer-skill-creator detail |
| Registry fields | `ProjectSkillRegistryEntry`, `src/gdskills/project-skills.ts`: `module,name,target,path,version,status,updatedAt` |
| Route ties go to the bundled skill | `src/commands/skills.ts:879-884` (`a.source.localeCompare(b.source)`, `"catalog" < "project"`) |
| Implementer reads `rules/core` only | `task-implementer/SKILL.md:202-228` |
| Implementer's only project-skill step is read-only | `task-implementer/SKILL.md:170-178` (`skills route`, `skills verify`, `skill_drift`) |
| Tests writer reads no rules | `tests-creator/SKILL.md:61-107` (Phase 1.2 reads existing tests) |
| Orchestrators dispatch both without project context | `job-orchestrator/SKILL.md:719-809`, `flow-orchestrator/SKILL.md:295-350` |
| Output contract has `skill_drift`, no applied-rules field | `task-implementer-output` (`additionalProperties: false`) |
| Validation entry | `keryx skills contracts validate`, `task-implementer/SKILL.md:456-462`, `src/gdskills/contracts.ts:369-372` |
| Shell and MCP skills operations | `src/harness/tool/metaproject-operations.ts` (`skillsCatalog`, `skill_load`), `src/mcp/metaproject-tools.ts` |

## 2. Design

### 2.1 Kinds and import (stage 1)

- `KNOWN_CATEGORIES` gains `implementation` and `testing`; the module directory is `project-skills/implementation/<name>/` or `.../testing/<name>/`. `wiringNote` for these modules changes from "not auto-injected" to "resolved by `skills resolve-context`".
- New flag `keryx skills import --rules <dir> [--only <glob>]` (also `--dry-run`, `--force`, `--allow-flagged` as for skills). Each `*.mdc`/`*.md` under `<dir>` is written to `.metaproject/rules/project/<relative path>` byte for byte. It uses the guard and containment code the skill import already uses (`writeContained`, `assertProjectWritesContained`, the security scan), and refuses any destination under `rules/core/`. The pattern is flow 416's `templates/` copy (`src/gdskills/import-skills-templates.test.ts`).
- Front matter (`description`, `globs`, `alwaysApply`) is parsed and stored in the registry next to `kind: rule` and the origin hash, so `skills update` can detect drift.
- A package skill may declare `taskTypes` (values of the bundled table) in front matter; stored as optional registry data.
- Old registries load unchanged; missing fields mean "no globs, no task types".

### 2.2 Resolver (stage 2)

`src/gdskills/context-resolver.ts`, exposed as `keryx skills resolve-context --files <f,...> [--task-type <t>] --for implement|test|review [--json]`.

Algorithm (pure function of the files on disk plus arguments):

1. Candidates: project rules (`.metaproject/rules/project/**`), project skills of kinds `implementation`/`testing` (for `--for implement|test`), bundled rules from the task-type table in `task-implementer` Phase 2.4 (always: `tdd-workflow`, `error-handling`, `solid-principles`; by type: the table; by detection: unchanged), and `testing` kind for `--for test`.
2. Match: a project rule matches when any `globs` entry matches a target file (repo-relative, minimatch semantics as the review path filters use; to be reused, not reimplemented) or `alwaysApply` is true. A project skill matches by `taskTypes` or by `target` through the existing route score.
3. Shadow: a project rule whose relative ref equals a bundled rule's ref removes the bundled entry and records `shadows: <bundled path>`.
4. Order: all project entries first, then bundled. Inside each group: glob specificity (fewer matched files per glob is more specific; exact path before `**`), then size ascending, then path (deterministic tie-break).
5. Budget: walk the project entries in order and add bytes until the next one would pass 40,960; those are `must_read`, the rest are `on_demand` (path, size, description). `alwaysApply: true` entries are listed with `index: true` when larger than 30 KB (or marked by front matter) and are `on_demand` unless they fit alone under their own limit. Bundled entries are not counted (they are today's baseline).
6. Output JSON: `{schema: 1, for, files, entries: [{kind, source, path, sha256, bytes, reason, tier: must_read|on_demand, shadows?}], budget: {limitBytes, usedBytes, exceeded}, warnings: []}`. `sha256` is of the file bytes. `reason` is one of `glob:<g>`, `always`, `task-type:<t>`, `route`, `bundled-default`.
7. Exit 0 always for a successful resolve; a budget overrun is a warning line on stderr and `budget.exceeded: true`.

Written to a file by the caller (`--out <path>`), whose path becomes `resolved_context_file`. The file lives beside the flow task evidence, so it is part of the record and is not part of the frozen AC.

### 2.3 Contracts (stage 2)

- `task-implementer-input.schema.json`: optional `resolved_context_file` (string path).
- `task-implementer-output.schema.json` and `tests-creator` output: `project_context_applied: [{path, sha256 (64 hex), how: "read"|"followed"|"n/a"}]`. Required when `resolved_context_file` was given. `additionalProperties: false` stays.
- `keryx skills contracts validate <result> --schema <name> --resolved <resolved.json>`: after schema validation, every entry with `tier: must_read` must appear in `project_context_applied` with the same `sha256`. Misses are listed with the entry's `reason`. `on_demand` entries are never misses. Exit code depends on enforcement (2.5).

### 2.4 Skill and orchestrator text (stages 0, 2, 3)

- Stage 0: `task-implementer` Phase 2.4 reads each rule at `rules/project/<ref>` then `rules/core/<ref>`; Phase 2.0b says a `fresh` project skill covering the target is applied. `tests-creator` gets a rules step (project-first). `skills route` tie-break: sort key `source === "project" ? 0 : 1` before `localeCompare`.
- Stage 2: `task-implementer` Phase 2 and `tests-creator` Phase 1 call `resolve-context` (`--for implement` / `--for test`) when no `resolved_context_file` was supplied, read the `must_read` entries, and report `project_context_applied`.
- Stage 3: `flow-orchestrator` dispatch contract and `job-orchestrator` Step A/B run `resolve-context` per task (target files from the task), pass `resolved_context_file` in the dispatch input, and run `contracts validate --resolved` on each result. Fix rounds included.
- Text guard: `src/gdskills/bundled-project-context.test.ts` (new) asserts the required sentences and fields exist in the bundled SKILL.md files (same style as existing bundled-skill text tests in `src/gdskills/bundled-eval.test.ts`).
- Installed copies: a project gets the new text only after `keryx update`.

### 2.5 Enforcement (stage 4)

Setting `gdskills.projectContext.enforcement`: `warn` (default) or `block`. Proposed home: a `gdskills` block in `.metaproject/tasks.config.json` (same file as `review.jev.edit_guard`); the actual file is to be confirmed in implementation. In `block` mode `contracts validate --resolved` exits non-zero on a miss. `keryx flow task done <id> <taskId>` for `implement`/`test` tasks reads the task's recorded result and resolved file, runs the same check, refuses in `block` and journals the miss in `warn`. Whether a task result is recorded where `task done` can read it is not verified; AC18 may need a small recording step (`--result <file>`), decided in implementation and reported.

### 2.6 Shell and MCP (stage 3)

Add `skills_resolve_context` beside `skills_catalog` and `skill_load` in `src/harness/tool/metaproject-operations.ts` and `src/mcp/metaproject-tools.ts`, same result as the CLI `--json`, with an output schema under `docs/requirements/keryx-project-implementation-rules/schemas/` (the existing operations mirror a schema in `docs/requirements/keryx-skills-runtime-tools/schemas/`).

## 3. What is not changed

- `review-orchestrator` and `project-reviewers.ts`: still module `review` only.
- Frozen AC checksums and the TDD order: the resolved file is an input before the RED commit.
- STATUS-first reply: the new field is in the JSON result.
- `rules/core/` ownership: still written only by `keryx init/update`.

## 4. Test plan (by AC)

| Tests | AC |
|---|---|
| `src/commands/skills-route.test.ts` (tie cases) | 1 |
| `src/gdskills/bundled-project-context.test.ts` (new): skill and orchestrator text | 2, 3, 14, 15 |
| `src/gdskills/import-skills.test.ts` (categories) | 4 |
| `src/gdskills/import-skills-rules.test.ts` (new): `--rules`, `--only`, dry-run, force, gate, containment, no `rules/core` | 5, 6 |
| `src/gdskills/project-skills.test.ts` (registry fields, old registry) | 7 |
| `src/gdskills/import-skills-update.test.ts`, `src/commands/skills-remove.test.ts` | 8 |
| `src/gdskills/context-resolver.test.ts` (new): order, shadows, selection, budget at 40,960/40,961, determinism | 9, 10, 11 |
| `src/gdskills/task-implementer-contract.test.ts`: schemas, `--resolved`, enforcement | 12, 13, 17 |
| `src/harness/tool/metaproject-operations.test.ts`, `src/mcp/metaproject-tools.test.ts` | 16 |
| `src/flow/task-project-context.test.ts` (new) | 18 |
| `src/cli-reference-coverage.test.ts`, `src/cli-docs-structure.test.ts` | 19 |
| `src/gdskills/project-reviewers.test.ts`, `rule-references.test.ts`, `src/review/reviewers.test.ts` | 20 |
| `src/gdskills/context-resolver.vantage.test.ts` (new) + `__fixtures__/vantage-rules/` | 21 |
| live run, operator present | 22 |

Per the operator's rule, the full suite runs on GitHub CI, not locally; local runs are the named files only.

## 5. Deviations and caveats

- Cap is on project content only; whether it should also count bundled rules is open (PRD section 11).
- `resolve-context` and `project_context_applied` are provisional names.
- "Both modes, import by default" is interpreted in PRD section 5.
- The glob matcher and the `alwaysApply`/index threshold (30 KB) are proposals, to be fixed against the real Vantage `globs`.

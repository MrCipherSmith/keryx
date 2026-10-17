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
- `--link` registers instead of copying: the registry stores origin path and sha256 per file (kind `rule`, `linked: true`). The security scan runs at registration and again at `skills update`. The resolver reads a linked rule from its origin only while the sha256 equals the recorded one; otherwise the entry is excluded with a warning. A copy of the same ref wins over a link.
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
5. Budget: the cap is `maxBytes` (default 131,072, from `gdskills.projectContext.maxBytes`, overridden by `--max-bytes`; outside 4,096..1,048,576 or non-integer reads as the default and adds a warning). Walk the project entries in order and add bytes until the next one would pass the cap; those are `must_read`, the rest are `on_demand` (path, size, description). A later, smaller entry may still fit after a skipped larger one only if it comes later in the order (the walk does not reorder). `alwaysApply: true` entries larger than 30,720 bytes are `index: true` and `on_demand`; smaller ones are ordinary candidates. Bundled entries are not counted (they are today's baseline). The overflow warning names the setting.
6. Output JSON: `{schema: 1, for, files, entries: [{kind, source, path, sha256, bytes, reason, tier: must_read|on_demand, index?, linked?, shadows?}], budget: {limitBytes, usedBytes, exceeded, limitSource: default|config|flag}, warnings: []}`. `sha256` is of the file bytes. `reason` is one of `glob:<g>`, `always`, `task-type:<t>`, `route`, `bundled-default`.
7. Exit 0 always for a successful resolve; a budget overrun is a warning line on stderr and `budget.exceeded: true`. Every call also records its result at `.metaproject/data/skills/project-context/last.json` (best effort, atomic write) for the TUI.

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

Settings live in a `gdskills.projectContext` block of `.metaproject/tasks.config.json` (same file as `review.jev.edit_guard`, reader modeled on `src/review/jev-edit-guard-config.ts`: fail-closed, never throws, unknown value reads as the default): `enforcement` `warn` (default) or `block`, and `maxBytes`. Writes preserve every other key (modeled on `writeJevEditGuardEnabled`). Module: `src/gdskills/project-context-config.ts`. In `block` mode `contracts validate --resolved` exits non-zero on a miss. `keryx flow task done <id> <taskId>` for `implement`/`test` tasks reads the task's recorded result and resolved file, runs the same check, refuses in `block` and journals the miss in `warn`. Whether a task result is recorded where `task done` can read it is not verified; AC18 may need a small recording step (`--result <file>`), decided in implementation and reported.

### 2.6 Shell and MCP (stage 3)

Add `skills_resolve_context` beside `skills_catalog` and `skill_load` in `src/harness/tool/metaproject-operations.ts` and `src/mcp/metaproject-tools.ts`, same result as the CLI `--json`, with an output schema under `docs/requirements/keryx-project-implementation-rules/schemas/` (the existing operations mirror a schema in `docs/requirements/keryx-skills-runtime-tools/schemas/`).

### 2.6b Project contract files and the hash pin (stage 2)

A second source of project rules: the project's own contract files (Vantage: `CLAUDE.md`, `.claude/rules/*.md`, `STYLING.md`, `THEMING.md` in vantage-frontend), which thin overlay rules cite instead of copying. Three mechanisms, all deterministic:

1. `--rules <dir-or-file> --link` can point at those files directly (a file path registers one file); their `globs` are optional, an entry without `globs` and without `alwaysApply` is an `on_demand` candidate selected only by reference.
2. A project rule's backtick-quoted repo-relative `.md`/`.mdc` paths are listed by the resolver as `kind: contract`, `tier: on_demand`, `reason: referenced-by:<rule>`. Guards (the text of a rule is untrusted): relative, no `..`, regular file, realpath inside the project root, at most 262,144 bytes, existing; anything else adds a warning and is not listed.
3. Every entry carries `sha256` in the resolved file. `contracts validate --resolved` re-hashes each listed file and reports pin drift for any entry whose current hash differs, so a standard edited between the RED and the GREEN step is visible. Warn mode reports, block mode fails.

The resolver does not read Vantage's `project-sources.json` (an overlay-private map); nothing here depends on it.

### 2.7 TUI (stage 3)

Modeled on `/editguard`: `src/tui/project-context-inspector.ts` (pure `formatProjectContextLines`, `renderProjectContextSidebarValue`, `isProjectContextCommand`, `openProjectContext` with an injected `loadStatus` and `setEnforcement`), registered in `tui-shell.ts` next to the edit-guard row (sidebar row `sb-project-ctx`, command branch, command-menu entry) and in the settings model (`settings-model.ts`: enforcement and cap rows). Status snapshot: enforcement and its source, cap and its source, counts of imported rules/linked rules/project skills, last resolve (`last.json`) summary. State x event matrix: `TUI-states.md`.

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
| `src/gdskills/project-context-config.test.ts` (new) | 11, 17 |
| `src/tui/project-context-inspector.test.ts` (new) | 24 |
| link mode in `import-skills-rules.test.ts` and `context-resolver.test.ts` | 23 |
| `src/flow/task-project-context.test.ts` (new) | 18 |
| `src/cli-reference-coverage.test.ts`, `src/cli-docs-structure.test.ts` | 19 |
| `src/gdskills/project-reviewers.test.ts`, `rule-references.test.ts`, `src/review/reviewers.test.ts` | 20 |
| `src/gdskills/context-resolver.vantage.test.ts` (new) + `__fixtures__/vantage-rules/` | 21 |
| live run, operator present | 22 |

Per the operator's rule, the full suite runs on GitHub CI, not locally; local runs are the named files only.

## 5. Deviations and caveats

- Cap is on project content only; whether it should also count bundled rules is open (PRD section 11). Default 128 KiB is a measured choice (85 KB frontend set plus 50% headroom), not an operator-stated number; the operator asked only for a configurable, "correct", raised cap.
- `resolve-context` and `project_context_applied` are provisional names.
- "Both modes, import by default" is interpreted in PRD section 5.
- The glob matcher and the `alwaysApply`/index threshold (30,720 bytes) are proposals, to be fixed against the real Vantage `globs`.

### 5.1 Safe defaults chosen by the implementation (operator-owned, change on request)

- Cap 128 KiB (131072 bytes), range 4096..1048576, set in `.metaproject/tasks.config.json` under `gdskills.projectContext.maxBytes`; `--max-bytes` overrides it for one call. `budget.exceeded` means a non-index project entry was pushed to `on_demand` by the cap.
- Enforcement `warn` by default; `block` is the flag. Under `block`, `flow task done` refuses an `implement`/`test` task with no recorded result; `--disposition skipped --reason` is the escape.
- The last result is written to `.metaproject/data/skills/project-context/last.json` by the CLI; the shell/MCP operation `skills_resolve_context` is pure and does not write it.
- Registry keys, `update --rules [<ref>]` and `remove --rule <ref>` are the maintenance flags. `--rules` takes a directory (`.mdc`, `.md`); `--link` reads it in place and excludes a linked rule whose file changed.
- Bundled rules are listed only if present in `.metaproject/rules/core`.
- The cap is shown in the settings row detail (`cap 128 KiB, this project`); editing it stays in the config file. The mode is switched by the row buttons and `/projectctx`.
- `alwaysApply` is applied as written; an always-apply rule larger than 30,720 bytes is an index (listed `on_demand`, never counted against the cap).
- Found while writing the docs: the CLI router (`src/lib/group-subcommands.ts`) did not list `resolve-context`, so `keryx skills resolve-context` answered `Unknown command` from the command line while direct calls passed. It is listed now and a test compares the dispatch with the list.
- Section 6 (P1–P4, Vantage thin-overlay compatibility) is a proposal and is not implemented.

## 6. Совместимость с Vantage thin-overlay и унификация

Source: vantage-ai-assistant `main` at 8c967fb (PR #16, `chore/thin-overlays-drift-sync`), read 2026-10-17: `README.md`, `scripts/project-drift.ts`, `scripts/keryx-upgrade.sh`, `skills/keryx-reviewer-setup/scripts/setup.sh`, `skills/vantage-rules-sync/SKILL.md`, `project-sources.json`. This section is a proposal for the operator. It changes no frozen AC (AC1-AC24) and no code of this flow.

### 6.1 What Vantage built, in the terms of this flow

- The overlay holds thin rules (40-90 lines) that point at the project's own contract files (`CLAUDE.md`, `.claude/rules/*.md`, `STYLING.md`, `THEMING.md`) by path and anchor. The project owns every value. This is the case AC23/AC25 (links and referenced contract files with a sha256 pin) were written for; it is now the main case, not an edge.
- `project-sources.json` maps each overlay file to the project files it depends on, records a baseline (project sha, Keryx release), lists the reviewers to register, the packages that must never be registered, and the Keryx files each overlay skill composes (`keryx.depends_on`).
- `scripts/project-drift.ts` (about 1,100 lines, bun) compares the overlay with the project at `origin/develop` via `git show` (the project working tree is never read) and with the installed Keryx. Its checks: upstream, unmapped, paths, anchors, lint-rules, path-gates, internal, retired-terms, indexes, coverage, sources, portability, forks, keryx, install. `--record-baseline` refuses while any non-upstream error remains.
- `scripts/keryx-upgrade.sh` (plan, snapshot, apply, diff) upgrades Keryx globally and re-runs `keryx update --skip-runtime`, the reviewer import and the drift check; `setup.sh` imports reviewers one by one (`keryx skills import --from ... --module review`) and the facade as module `orchestration`.
- The law "an overlay skill that shares a name with a Keryx bundled skill is a fork and is deleted" matches PRD section 3 (non-goal: same-name project skill).

### 6.2 Honest comparison

Vantage is ahead on: drift detection against the project's source of truth (anchors, paths, retired terms, lint rules and path gates are verified, not just hashed); a recorded baseline per project sha; tracking of the Keryx release and of the exact bundled files a facade composes; snapshotting a Keryx release before an upgrade; the "never register" list.

This flow is ahead on: a deterministic resolver that selects rules for a task (globs, taskTypes), a byte cap with an `on_demand` split instead of loading everything, `project_context_applied` in the implementer result with a validator and `warn`/`block` enforcement, the sha256 pin of linked files at the moment of use (AC13, AC23), `shadows` reporting, the TUI representation (AC24). Vantage has no equivalent of the resolver: its rules reach reviewers through the Keryx project slot only.

Duplicated in Vantage scripts, and already owned or about to be owned by Keryx:

- Copy and link bookkeeping for imported rules (`setup.sh` step 2 only reports `shadowedRules`; Keryx already writes `rules/project/<dir>/`).
- Reviewer inventory checks (`keryx review reviewers` is parsed with awk/grep in `setup.sh`; a `--json` form exists and is already used for one step).
- The `MIN_KERYX` gate and the `install` group ("installed copies differ"): this re-derives from files what the `keryx skills` registry already holds (origin, hash, `changed`).
- A hash baseline per mapped file in `project-sources.json`: the same job as the sha256 pin of AC23, written by hand and checked only by the overlay's own script.

Vantage-only and not to be absorbed: lint-rule, path-gate, retired-term and index checks; the `vantage-rules-sync` subagent-per-area procedure; the Cursor/OpenCode/Qwen/Zed mirrors (`sync-skills.sh`, `sync-rules.sh`). These are Vantage's runtime and doctrine.

### 6.3 Decisions proposed (D-V1..D-V5)

- D-V1. Keep the resolver independent of Vantage's `project-sources.json` (section 2.6b stands). The resolver reads Keryx's own registry (`link` entries with path and sha256) and the project's contract files; it never parses a foreign manifest. Vantage may generate the Keryx registry entries from its manifest in `setup.sh`; that is its integration, not a Keryx dependency.
- D-V2. After flow 461, add a generic read-only command, working name `keryx skills drift [--project <dir>] [--json]`. For every imported or linked package and rule it reports: the origin path exists; the origin sha256 equals the recorded one (`changed`); cited rules resolve; a linked contract file still exists and matches its pin; a package shadows a Keryx bundled name (the "fork" case); the registry copy differs from the installed copy. Exit 0 clean, 1 findings, 2 usage. This absorbs the Vantage `install`, `forks`, `portability` and `paths` checks for any project and leaves anchors, lint-rules, path-gates and retired terms to the overlay's own script, which can call `keryx skills drift --json` first.
- D-V3. Add `keryx skills sources` (read-only): the recorded baseline per origin (origin path or repo, commit sha when the origin is a git checkout, hashes, Keryx version at import time), and `keryx skills sources --record` to store it in the registry. This replaces a hand-kept baseline per project with a Keryx-owned one. It reads no project documents beyond hashing the files the registry already lists.
- D-V4. Leave the global upgrade and the runtime mirrors out of Keryx. `keryx-upgrade.sh` mutates the global npm install and `sync-skills.sh` prunes agent runtimes; both are operator-side decisions. Keryx adds only the "Keryx moved past the recorded version" line to `keryx skills drift`.
- D-V5. One import path: after flow 461 is released, Vantage's `setup.sh` calls `keryx skills import --rules <dir> [--link]` (AC4-AC8) for the rules it cites, instead of relying on reviewer citation only. Until then it keeps working, because reviewer import is unchanged (AC20).

### 6.4 Open questions for the operator

1. Take D-V2 and D-V3 as a separate follow-up flow after 461, with its own PRD and AC (recommended: yes, since 461's AC are frozen)?
2. Should `keryx skills drift` exit 1 on findings by default (CI-failing) or only warn?
3. Baseline home: the Keryx registry (D-V3), or Vantage's `project-sources.json` as the single source that Keryx reads? D-V1 recommends the first; the second is faster for Vantage but couples Keryx to a foreign format.
4. Vantage `project-sources.json` lists `skills/screen-recording`, which does not exist in the overlay repo, so its coverage check fails on any clean clone. This is a Vantage bug for its owner; it does not affect this flow.

### 6.5 Proposed new criteria (not added to the frozen set)

For the follow-up flow, not for 461:

- P1. `keryx skills drift --json` on a project with one linked rule whose origin changed reports exactly that rule as `changed` and exits 1; on a clean project it exits 0.
- P2. A project skill named like a bundled Keryx skill is reported as `fork`.
- P3. `keryx skills sources` output is stable (sorted, no timestamps), so it can be committed and diffed.
- P4. Neither command writes outside `.metaproject/` and neither executes origin content.

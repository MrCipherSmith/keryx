# gdskills: technical specification

Version: 0.19.0

## 1. Purpose

`gdskills` is a Metaproject module for managing skill lifecycle. It owns the working skills and orchestrators that create, verify, learn, route, export and sync skills.

The system has two separate skill domains:

- `gdskills` - native Metaproject working skills and orchestrators bundled with `gd-metapro`.
- `project-skills` - content-dependent skills bound to target-project entities: modules, components, stores, feature components, services, domain concepts and wiki pages.

The `gd-metapro` package must contain its own working skill catalog. Similar projects and prior internal systems can be used as design references, but an initialized project must work when `goodai-base` is not installed and cannot depend on `~/goodai-base` paths.

## 2. Placement

When enabled, `gd-metapro init` should create:

```text
.metaproject/
  skills/
    gdskills/
      entity-skill-router/
        SKILL.md
      entity-skill-creator/
        SKILL.md
      entity-skill-verifier/
        SKILL.md
      entity-skill-learner/
        SKILL.md
      core/
      orchestration/
      review/
      project-docs/
  project-skills/
    <module>/
      <entity>/
        SKILL.md
        references/
        templates/
        verification.md
        skill-changelog.md
  data/
    gdskills/
      artifacts/
      reports/
      proposals/
  modules/
    gdskills.md
```

Canonical generated project skills are stored under:

```text
.metaproject/project-skills/<module>/<entity>/
```

For future large modules, code-local reference files may point back to `.metaproject/project-skills`, but the canonical project skill package remains in `.metaproject/project-skills`.

Runtime/exported skills for Codex, Claude or other agent runtimes are generated from canonical project skills. Runtime artifacts must follow the target runtime best practices and must not include Metaproject management files that are not needed by the agent.

## 2.1 Skill responsibilities

`gdskills` must not treat create, verify and learn as one monolithic agent-facing skill.

Working skills:

| Skill | Responsibility |
|---|---|
| `entity-skill-router` | Selects relevant project skills for user tasks and tells the agent when to load them. |
| `entity-skill-creator` | Creates canonical project skills from path, symbol or wiki target. |
| `entity-skill-verifier` | Checks project skills against code, graph, wiki, health and memory. Also exposed as `skill-verify-skill`. |
| `entity-skill-learner` | Updates project skills from review, test, health, memory and verifier findings. |

Reusable working skills and orchestrators live under the `gdskills` working domain, not under `project-skills`.

## 2.2 Native bundled skill strategy

The `gd-metapro` distribution should ship a native working skill catalog with these areas:

| Area | Local target | Notes |
|---|---|---|
| `core` | `.metaproject/skills/gdskills/core/` | Everyday workflow, hooks, audits, dependency updates, brainstorm/interviewer-style clarification and utility skills. |
| `orchestration` | `.metaproject/skills/gdskills/orchestration/` | Job orchestration, context collection, issue analysis, task implementation and verification workflows. |
| `review` | `.metaproject/skills/gdskills/review/` | Review orchestrator and specialized review skills. |
| `project-docs` | `.metaproject/skills/gdskills/project-docs/` | PRD, project documentation and autodoc workflows that can feed `gdwiki`, `gdctx` and Documentation Memory. |
| scripts/catalog/sync utilities | `.metaproject/core/gdskills/` | Registry generation, skill catalog generation, runtime export and runtime sync. |

Bundling rules:

- ship these skills inside the `gd-metapro` repository/package;
- treat `goodai-base` only as historical/reference material during product design;
- do not require `goodai-base`, `~/goodai-base`, global goodai skills or any external skill repository at runtime;
- keep user/project-specific generated skills in `.metaproject/project-skills`;
- expose native working skills through the local `.metaproject/index.md` and `.metaproject/skills/catalog.md`.

### 2.2.1 Maximum bundled gdskills package

The full `gd-metapro` package should include the following native skills and orchestrators.

Core and routing:

| Skill | Purpose |
|---|---|
| `metaproject-router` | Chooses which Metaproject module, working skill or project-skill should be used for a user request. |
| `project-rules` | Routes agents to imported root rules from `.metaproject/rules`. |
| `context-router` | Chooses between `gdgraph`, `gdctx`, `gdwiki`, Documentation Memory, Code Health and project-skills before raw file reads. |
| `entity-skill-router` | Selects relevant project-skills for known modules/components/entities. |
| `entity-skill-creator` | Creates canonical project-skills from path, symbol or wiki target. |
| `entity-skill-verifier` | Verifies project-skills against graph, ctx, wiki, health and memory. |
| `entity-skill-learner` | Updates project-skills from review, test, health, memory and verifier findings. |

Orchestration:

| Skill | Purpose |
|---|---|
| `job-orchestrator` | Runs full task pipelines: clarify, collect context, plan, implement, verify, review and summarize. |
| `job-documenter` | Creates and updates persistent job documentation when an orchestrated job needs traceability. |
| `context-collector` | Builds compact task context from graph, ctx, wiki, memory, health and selected files. |
| `issue-analyzer` | Converts GitHub/local issues into atomic implementation tasks. |
| `task-implementer` | Implements one atomic task end to end using local project context and verification. |
| `code-verifier` | Runs and summarizes verification gates: typecheck, lint, tests, build and import checks. |
| `feature-analyzer` | Analyzes a feature/module/branch area and produces an implementation or migration map. |
| `feature-dev` | Guided feature workflow from requirements to implementation, verification and PR-ready summary. |

Review:

| Skill | Purpose |
|---|---|
| `review-orchestrator` | Routes review requests to specialized reviewers and consolidates findings. |
| `review-logic` | Checks correctness, contracts, edge cases, nullability and async behavior. |
| `review-architecture` | Checks boundaries, dependency direction, layering and abstraction stability. |
| `review-security-code` | Checks code-level security risks, injections, auth gaps and secrets. |
| `review-performance` | Checks hot paths, unnecessary work, bundle/perf regressions and blocking operations. |
| `review-frontend` | Checks frontend component, state and view/store patterns. |
| `review-backend` | Checks backend service, API, DTO and data-access patterns. |
| `review-style` | Checks naming, readability, dead code and duplication. |
| `review-clean-code` | Checks function/class-level maintainability and SOLID issues. |
| `review-highload` | Checks concurrency, retry storms, idempotency, queues and high-traffic risks. |
| `review-testing-practices` | Checks test structure, coverage quality, determinism and repository test conventions. |
| `review-core-boundaries` | Checks shared/core module coupling and public surface stability. |
| `review-flow-graph` | Checks graph/flow UI or graph-surface abstractions when relevant. |
| `review-strict` | Performs strict meta-review over findings and weak assumptions. |
| `review-pr-feedback` | Parses review comments and converts them into fixes, lessons and skill-learning proposals. |

Quality, workflow and operations:

| Skill | Purpose |
|---|---|
| `security-audit` | Runs dependency and secret/security checks and normalizes findings. |
| `perf-check` | Runs or summarizes performance and bundle/complexity checks. |
| `test-gen` | Generates tests for a file/module using local patterns and existing test stack. |
| `tests-creator` | Creates test scenarios before implementation from acceptance criteria. |
| `dependency-update` | Plans and verifies dependency upgrades. |
| `db-migrate` | Guides migration creation, apply, rollback and status flows. |
| `deploy` | Runs pre-flight checks and deployment workflow summaries. |
| `commit` | Prepares conventional commits with scope and verification summary. |
| `push` | Pushes branches with safety checks and upstream handling. |
| `pr` | Prepares pull request creation/update context. |
| `pr-issue-documenter` | Creates PR descriptions and linked issue documentation from changes. |
| `changelog` | Generates changelog or release notes from commits/tags. |

Planning, discovery and documentation:

| Skill | Purpose |
|---|---|
| `brainstorm` | Explores architecture/product options with trade-offs and recommendation. |
| `interviewer` | Asks focused clarification questions before expensive or ambiguous work. |
| `prd-creator` | Converts vague requests into structured PRD and acceptance criteria. |
| `project-discovery` | Collects initial project facts, modules, constraints and stakeholders. |
| `problem-definer` | Defines goals, non-goals, risks and success metrics. |
| `stack-advisor` | Recommends stack choices based on project level and constraints. |
| `patterns-researcher` | Finds architecture and implementation patterns for selected stack/domain. |
| `spec-writer` | Writes PRD/spec/implementation plan constrained by decisions and evidence. |
| `consistency-checker` | Checks PRD/spec/plan consistency against decisions, wiki and memory. |
| `planner` | Produces roadmap, milestones, task breakdown and dependency graph. |
| `autodoc-orchestrator` | Coordinates reverse-engineering documentation for an existing codebase. |
| `autodoc-scanner` | Scans project structure, stack and module map. |
| `autodoc-analyst` | Analyzes one module/component/service area. |
| `autodoc-architect` | Synthesizes system architecture from module analyses. |
| `autodoc-writer` | Writes focused documentation sections. |
| `autodoc-assembler` | Assembles final documentation package and indexes. |

Platform/configuration:

| Skill | Purpose |
|---|---|
| `agent-entrypoint-manager` | Maintains `AGENTS.md`, `CLAUDE.md` and local-first Metaproject references. |
| `hook-manager` | Creates and verifies lightweight git hooks for graph, health and skill verification. |
| `skill-catalog-manager` | Generates `.metaproject/skills/catalog.md` and machine-readable skill registry. |
| `skill-runtime-exporter` | Exports canonical skills to runtime-compatible Codex/Claude artifacts. |
| `skill-sync` | Syncs exported skills to configured local runtimes only when explicitly enabled. |

### 2.2.2 Install profiles

`gd-metapro init` should support install profiles:

| Profile | Includes | Recommended use |
|---|---|---|
| `minimal` | routers, project-rules, gdgraph/gdctx/gdwiki skills, entity-skill lifecycle | Small projects or early MVP. |
| `recommended` | `minimal` + orchestration, review, quality, planning and docs essentials | Default for most projects. |
| `full` | Entire maximum bundled package | Large projects, multi-agent workflows, advanced automation. |
| `custom` | User selects categories and individual skills | Teams with strict constraints. |

Default recommendation: `recommended`.

The package may ship all skills, but `init` should install only the selected profile into `.metaproject/skills/gdskills/`. Global runtime sync remains opt-in.

### 2.2.3 Orchestrator communication contracts

All gdskills orchestrators and subagents must use native Metaproject JSON Schema contracts for machine-readable communication.

Reference document: [orchestrator-contracts.md](./orchestrator-contracts.md).

Installed contracts:

```text
.metaproject/
  core/
    gdskills/
      contracts/
        agent-event.schema.json
        orchestrator-state.schema.json
        review-finding.schema.json
        subagent-dispatch.schema.json
        subagent-result.schema.json
```

Required protocol:

- orchestrator -> subagent messages use `subagent-dispatch.schema.json`;
- subagent -> orchestrator messages use `subagent-result.schema.json`;
- review findings use `review-finding.schema.json`;
- resumable orchestrators persist `orchestrator-state.schema.json`;
- all orchestrators that dispatch subagents append events compatible with `agent-event.schema.json`;
- Markdown summaries are allowed only as human-readable companion fields, not as the primary machine contract.

Statuses:

- `DONE`;
- `DONE_WITH_CONCERNS`;
- `NEEDS_CONTEXT`;
- `BLOCKED`;
- `FAILED`.

Every dispatch must include explicit task, acceptance criteria, context refs, files to read, constraints, allowed actions, output contract, budget and provenance. Subagents must not rely on inherited chat history.

Validation commands:

```bash
gd-metapro skills contracts list
gd-metapro skills contracts validate <file> --schema subagent-result
```

## 2.3 Agent entrypoint priority

When `gdskills` is enabled, `gd-metapro init` must update or create `AGENTS.md` and `CLAUDE.md` so the agent resolves context in this order:

1. Project-local `.metaproject/index.md`.
2. Project-local `.metaproject/skills/catalog.md`.
3. Project-local `.metaproject/project-skills/**`.
4. Native working skills under `.metaproject/skills/gdskills/**`.
5. External or globally installed skill catalogs only as optional fallback when the project explicitly allows it.

This prevents `AGENTS.md`/`CLAUDE.md` from routing to stale external skill sets when the project has its own Metaproject configuration.

## 3. Dependencies

`gdskills` depends on:

- `gdgraph` for file/symbol relationships, affected context and candidate skill detection.
- `gdctx` for compact command, search, diff and file context.
- `gdwiki` for architecture, business rules, known decisions and domain concepts.
- Code Health for normalized quality findings, health metrics, regressions and skill-owned scope signals.
- Documentation Memory for accepted lessons, decisions, constraints, known mistakes, patterns and historical context.

If one dependency is disabled, `gdskills` should degrade gracefully and record missing evidence in verification reports.

## 4. CLI

Namespace:

```bash
gd-metapro skills <command>
```

### 4.1 generate

```bash
gd-metapro skills generate <target>
```

Supported target types:

- path: `src/pipelines/steps/http-step`;
- symbol: `PipelineStepStore`;
- wiki reference: `wiki://pipelines/steps`.

Primary command:

```bash
gd-metapro skills create <target> --name <skill-name>
gd-metapro skills create <target> --module <module-name>
gd-metapro skills create <target> --format auto|single|package
gd-metapro skills create <target> --autonomy suggest-only|auto-high-confidence|fully-autonomous
gd-metapro skills create <target> --dry-run
```

Alias:

```bash
gd-metapro skills generate <target> --module <module-name> --name <skill-name>
```

Behavior:

1. Normalize target into an entity descriptor.
2. Query `gdgraph` for related files, symbols, dependents and tests.
3. Use `gdctx` to collect compact code context and command output.
4. Use `gdwiki` to collect related wiki pages and decisions.
5. Classify patterns: architecture, UI/design, stores/state, business logic, tests, review rules.
6. Generate skill package.
7. Create or update `skill-changelog.md`.
8. Register skill in `.metaproject/index.md` and `.metaproject/metaproject.json`.

### 4.2 verify

```bash
gd-metapro skills verify <skill-or-target>
```

Aliases:

```bash
gd-metapro skill-verify-skill <skill-or-target>
```

Behavior:

1. Resolve skill package from path, symbol, wiki reference or skill path.
2. Read ownership map.
3. Use `gdgraph affected` to detect impacted skills.
4. Use `gdctx` and `gdwiki` for semantic verification.
5. Compare current evidence with skill claims, templates, checklists and review lessons.
6. Report `fresh`, `stale`, `needs-review` or `blocked`.
7. Create proposed update or apply allowed machine-managed updates based on autonomy config.

First implementation slice:

- resolves package by path, `module/name`, manifest entry or target;
- checks required package files and `SKILL.md` metadata;
- checks target path existence when target is path-like;
- checks availability of gdgraph, gdctx, gdwiki, Code Health and Documentation Memory evidence artifacts;
- writes report to `.metaproject/data/gdskills/reports/<module>-<skill>-verification.json`;
- updates package `verification.md` and `Last Verified` metadata;
- reports `fresh`, `needs-review`, `stale` or `blocked`.

### 4.3 learn

```bash
gd-metapro skills learn --from-review <path>
gd-metapro skills learn --from-test <path>
gd-metapro skills learn --from-failure <path>
gd-metapro skills learn --from-health <path>
gd-metapro skills learn --from-memory <path>
gd-metapro skills learn apply <proposal.json>
```

Behavior:

1. Parse source report.
2. Map findings to affected skills.
3. Classify each finding:
   - `lesson`;
   - `anti-pattern`;
   - `template-change`;
   - `checklist-change`;
   - `workflow-change`;
   - `architecture-rule`;
   - `health-rule`;
   - `memory-rule`.
4. Update generated sections if policy allows it.
5. Preserve manual sections.
6. Increment skill version.
7. Append to `skill-changelog.md`.

First implementation slice:

- parses Markdown, text and JSON sources;
- supports explicit `--skill <module>/<skill>` mapping;
- falls back to registry target matching when `--skill` is omitted;
- writes proposal JSON and Markdown under `.metaproject/data/gdskills/proposals/`;
- records source type, source path, confidence, candidate lessons and suggested sections;
- does not mutate `SKILL.md` during proposal creation;
- applies proposals only through explicit `gd-metapro skills learn apply <proposal.json>`;
- on apply, updates `SKILL.md`, bumps patch version, appends `skill-changelog.md` and writes an `.applied.json` audit file.

### 4.4 status

```bash
gd-metapro skills status
gd-metapro skills status --json
```

Shows:

- number of entity skills;
- stale skills;
- last verification time;
- skills with pending proposals;
- skills with missing graph/wiki/ctx evidence.

First implementation slice:

- reports gdskills initialization, enabled state and profile;
- reports bundled skill count, installed root and catalog path;
- reports registered project-skill count;
- reports project skills without verification reports;
- reports verification status counts: `fresh`, `needs-review`, `stale`, `blocked`;
- reports latest verification timestamp;
- reports learning proposals: total, pending and applied;
- supports machine-readable `--json` output.

### 4.4.1 discovery

```bash
gd-metapro skills list
gd-metapro skills list --json
gd-metapro skills inspect <project-skill>
gd-metapro skills inspect <project-skill> --json
gd-metapro skills route <query-or-target>
gd-metapro skills route <query-or-target> --json
```

Behavior:

1. Read `.metaproject/metaproject.json`.
2. List registered project-skills without loading all skill files.
3. Resolve one skill by `module/name`, skill name, path or target.
4. Report version, status, last verified, package files and latest verification report.
5. Route a query/file/symbol/task description to likely project-skills with scoring reasons.
6. Never mutate files or run verification.

### 4.5 export

```bash
gd-metapro skills export <project-skill> --runtime codex
gd-metapro skills export <project-skill> --runtime claude
gd-metapro skills export <project-skill> --runtime codex --dry-run
```

Behavior:

1. Read canonical project skill package.
2. Produce runtime-compatible skill artifact.
3. Keep `SKILL.md` concise and procedural.
4. Move detailed context into `references/`.
5. Move deterministic scripts into `scripts/`.
6. Move reusable templates/assets into `assets/`.
7. Exclude management-only files such as `skill-changelog.md` unless the target runtime explicitly needs them.

First implementation slice:

- resolves project skill by path, `module/name`, manifest entry or target;
- writes runtime artifact to `.metaproject/runtime/skills/<runtime>/<module>-<skill>/`;
- copies `SKILL.md`;
- copies safe `references/`, `templates/`, `assets/` and `scripts/` directories;
- excludes `skill-changelog.md`, `verification.md`, proposals, reports and audit files;
- writes `export-manifest.json`;
- supports `--dry-run` and `--json`.

### 4.6 sync

```bash
gd-metapro skills sync --runtime codex --target <dir>
gd-metapro skills sync --runtime claude --target <dir>
```

Synchronizes exported runtime skills to configured agent runtime locations.

First implementation slice:

- reads exported artifacts from `.metaproject/runtime/skills/<runtime>/`;
- requires explicit `--target <dir>`;
- copies exported skill packages into the target directory;
- writes `gd-metapro-sync-manifest.json`;
- supports `--dry-run` and `--json`;
- does not auto-detect or write to global runtime folders;
- does not delete stale files in target directories.

## 5. Skill package format

### 5.1 Canonical project skill: single-file format

Used for simple entities:

```text
.metaproject/project-skills/<module>/<entity>/
  SKILL.md
  skill-changelog.md
```

### 5.2 Canonical project skill: package format

Used for complex entities:

```text
.metaproject/project-skills/<module>/<entity>/
  SKILL.md
  references/
    context.md
    patterns.md
    business-rules.md
  templates/
    component.template.md
    store.template.md
    test.template.md
  verification.md
  skill-changelog.md
```

### 5.3 Runtime/exported skill format

Runtime/exported skills must follow Codex/Claude skill best practices:

```text
<skill-name>/
  SKILL.md
  references/
  scripts/
  assets/
  agents/
    openai.yaml
```

Requirements:

- `SKILL.md` has runtime metadata with `name` and `description`.
- `description` clearly states when the skill should trigger.
- `SKILL.md` body stays concise and procedural.
- Long or variant-specific details move to `references/`.
- Deterministic operations move to `scripts/`.
- Reusable templates and boilerplate move to `assets/`.
- Avoid runtime clutter: no `README.md`, installation guide or `skill-changelog.md` in exported runtime skill.
- `skill-changelog.md`, provenance and verification details remain in the canonical `.metaproject/project-skills/...` package.

### 5.4 Required canonical SKILL.md sections

```markdown
# <Entity> Skill

Version: 0.1.0
Target: <path|symbol|wiki>
Module: <module>
Status: active
Last Verified: <date or never>

## Purpose

## When To Use

## Evidence

## Files To Read

## Architecture Rules

## Business Rules

## Implementation Patterns

## Create Workflow

## Refactor Workflow

## Questions To Ask

## Testing Rules

## Review Checklist

## Anti-patterns

## Review Lessons

## Verification
```

## 6. Best-practice skill creation rules

`entity-skill-creator` must create skills according to Codex/Claude-compatible practices:

- Treat a skill as an operational procedure, not long-form documentation.
- Keep always-loaded metadata small and precise.
- Make `description` specific enough for reliable skill selection.
- Use progressive disclosure: `SKILL.md` first, `references/` only when needed.
- Do not duplicate information between `SKILL.md` and references.
- Use scripts for fragile or repeatable operations.
- Keep memory outside runtime skills; use Documentation Memory as an external signal.
- Keep management metadata outside runtime exported skills.

## 7. Managed sections

Generated files must protect manual edits.

Machine-managed sections use markers:

```markdown
<!-- gdskills:generated:start section="evidence" source="gdgraph,gdctx,gdwiki" -->
...
<!-- gdskills:generated:end -->
```

Manual sections must not be overwritten unless the user passes an explicit force flag.

## 8. Versioning and changelog

Every skill has:

- `Version` in `SKILL.md`;
- `skill-changelog.md` next to `SKILL.md`.

Each changelog entry must include:

- version;
- date;
- reason;
- source: code-change, wiki decision, review, test failure, verifier, health, memory;
- health report path and finding ids when source is Code Health;
- memory entry ids and statuses when source is Documentation Memory;
- changed sections;
- affected files;
- confidence;
- applied mode: manual, auto, orchestrator, hook.

## 9. Freshness model

Verifier uses a five-stage model:

1. Ownership signal:
   - `owned_files`;
   - `observed_files`;
   - `observed_globs`.
2. Graph signal:
   - `gdgraph affected <target>`;
   - dependency and dependent changes.
3. Semantic signal:
   - current code structure;
   - exports and symbols;
   - store/component patterns;
   - wiki decisions;
   - review lessons;
   - tests.
4. Health signal:
   - lint/type/test/coverage/complexity/audit findings in skill-owned scope;
   - repeated findings in owned files;
   - health regressions for related module/entity/file scopes;
   - quality gate status for changed/affected scopes.
5. Memory signal:
   - accepted lessons related to skill-owned files/modules/entities;
   - accepted decisions and constraints that conflict with skill instructions;
   - accepted known mistakes not represented in anti-patterns or checklists;
   - accepted patterns that should be reflected in templates or workflows;
   - draft entries as advisory context only.

Only candidate skills from stages 1-2 should receive expensive semantic, health-aware and memory-aware verification.

### 9.1 Code Health integration

Code Health is an official input for `skill-verify-skill`.

`skill-verify-skill` should use health data when:

- a skill owns or observes files with P0/P1 findings;
- a skill-owned entity regressed in `health_score`, `risk_score`, coverage or complexity;
- the same lint/type/test/audit finding repeats across multiple runs;
- health findings indicate that templates/checklists in the skill are missing required constraints.

Supported command:

```bash
gd-metapro skills learn --from-health .metaproject/data/health/artifacts/latest.json
```

Health findings can update:

- `Review Lessons`;
- `Anti-patterns`;
- `Testing Rules`;
- `Review Checklist`;
- templates in `templates/`;
- `Verification` rules.

Every health-derived update must include health report path, finding ids, affected scopes and confidence in `skill-changelog.md`.

### 9.2 Documentation Memory integration

Documentation Memory is an official input for `skill-verify-skill`.

`skill-verify-skill` should use memory data when:

- accepted memory entries relate to the skill target, module, entity, files or skill path;
- a skill instruction conflicts with an accepted decision or constraint;
- a known mistake should be reflected in `Anti-patterns`, `Review Checklist` or templates;
- an accepted lesson or pattern should update implementation/refactor/testing workflow.

Supported command:

```bash
gd-metapro skills learn --from-memory .metaproject/data/memory/artifacts/latest.json
```

Memory-derived learning rules:

- only `accepted` entries can automatically update skills;
- `draft` entries are advisory context;
- `conflict` entries must not automatically update skills;
- memory-derived changes must include memory entry ids, statuses, related scopes and provenance in `skill-changelog.md`;
- accepted decisions/constraints outrank draft or inferred skill rules.

## 10. Autonomy policy

Configurable per project/module/entity:

```json
{
  "gdskills": {
    "autonomy": "fully-autonomous",
    "hooks": {
      "verifySkills": true
    },
    "modules": {
      "pipelines": {
        "autonomy": "auto-high-confidence"
      }
    }
  }
}
```

Supported modes:

- `suggest-only` - never applies changes automatically.
- `auto-high-confidence` - applies generated section updates when confidence is high.
- `fully-autonomous` - applies allowed generated section updates and changelog updates automatically.

Manual sections remain protected in all modes.

## 11. Init flow

`gd-metapro init` must ask:

```text
Enable gdskills for skill lifecycle management?

Y. Yes - installs working skills for creating, verifying, learning and routing project-skills
N. No
```

If enabled:

```text
Install git hook to run project-skill verification for changed entities?

Y. Yes - keeps entity skills aligned with code, wiki and review lessons
N. No - run gd-metapro skills verify manually or via orchestrators
```

The hook must be optional.

## 12. Hook behavior

MVP hook should be lightweight:

1. Detect changed files since previous commit or staged changes depending on hook type.
2. Map changed files to candidate skills through ownership map and `gdgraph affected`.
3. Run semantic verification only for candidates.
4. Write report to `.metaproject/data/gdskills/reports/latest.md`.
5. Apply updates only if autonomy policy allows it.

First implementation slice:

- installs only when `gdskills` is enabled and the user accepts the hook prompt;
- `gd-metapro init --yes` enables it by default;
- `--no-gdskills-hook` disables it;
- writes a managed block into `.git/hooks/post-commit`;
- preserves existing hook content and other `gd-metapro` managed blocks;
- detects relevant changed paths and runs `gd-metapro skills verify --all`;
- never blocks the commit when verification fails.

## 13. Orchestrator integration

Orchestrators should use `gdskills` at three points:

1. Before implementation/refactor:
   - resolve relevant entity skills;
   - include skill path in subagent context.
2. After review:
   - map review findings to entity skills;
   - run `gd-metapro skills learn --from-review`.
3. Before completion:
   - run `gd-metapro skills verify` for changed entities;
   - report skill updates in the final job summary.

Subagent dispatches must include explicit context blocks: task, acceptance criteria, context, files to read and constraints.

## 14. Git policy

Versioned:

- `.metaproject/skills/**/*.md`;
- `.metaproject/project-skills/**/*.md`;
- `.metaproject/project-skills/**/templates/**`;
- `.metaproject/project-skills/**/references/**`;
- `.metaproject/modules/gdskills.md`;
- `.metaproject/data/gdskills/proposals/**/*.md` when proposals are intentionally kept.

Ignored:

- `.metaproject/data/gdskills/reports/latest.md`;
- transient verifier logs;
- caches and raw command outputs.

## 15. Acceptance criteria

- `gd-metapro init` can enable `gdskills` and ask about hook installation.
- `gd-metapro skills generate <path>` creates a versioned canonical project skill package.
- Generated skill references `gdgraph`, `gdctx` and `gdwiki` evidence.
- `gd-metapro skills verify <skill>` detects stale skills.
- `gd-metapro skills learn --from-review <path>` can create or apply a skill update.
- `gd-metapro skills learn --from-health <path>` can create or apply a health-derived skill update.
- `gd-metapro skills learn --from-memory <path>` can create or apply a memory-derived skill update.
- Every skill update increments `Version` and appends `skill-changelog.md`.
- Manual sections are protected from automatic overwrite.
- Runtime/exported skills are compact Codex/Claude-compatible artifacts derived from canonical project skills.

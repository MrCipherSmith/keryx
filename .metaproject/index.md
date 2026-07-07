# Metaproject Index

## Purpose

This `.metaproject` folder contains agent-readable context, tools, generated data, and module manifests for this codebase.

Human dashboard: [gd-metapro-dashboard.html](gd-metapro-dashboard.html)

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |
| gdctx | Token-aware command output and context compression | modules/gdctx.md |
| gdskills | Native bundled working skills, orchestration, review, and project-skill lifecycle | modules/gdskills.md |
| health | Code quality aggregation, scoring, and quality gate | modules/health.md |
| testing | Test context, related tests, execution reports, and test intelligence | modules/testing.md |
| memory | Long-lived project memory: lessons, decisions, constraints, known mistakes | modules/memory.md |
## Rules

| Source | Purpose | Entry |
|--------|---------|-------|
| AGENTS.md | Imported repository agent instructions | rules/agents-md.md |
| agents.md | Imported repository agent instructions | rules/agents-md.md |

## Skills

| Skill | Purpose | Entry |
|-------|---------|-------|
| project-rules | Use imported repository rules before planning or editing | skills/project-rules/ |
| gdgraph | Default navigation layer for finding relevant project files before broad raw search | skills/gdgraph/SKILL.md |
| gdctx | Use compact command/search/read outputs before loading large raw output | skills/gdctx/SKILL.md |
| gdskills | Use project-local bundled working skills and project-skill routing before external/global skills | skills/catalog.md |
| health | Read data/health/artifacts/latest.md before claiming quality status or gate results | skills/health/SKILL.md |
| testing | Read testing context before creating/changing tests and normalized reports before raw test logs | skills/testing/SKILL.md |
| memory | Search accepted project memory before historical, decision, and repeated-mistake questions | skills/memory/SKILL.md |

## Agent Workflow

1. Read this file first.
2. Check enabled modules.
3. Load relevant rules from `rules/`.
4. Route by question type: structural questions go to gdgraph first; conceptual questions go to gdwiki first; gdctx runs in parallel to keep output compact.
5. For structural questions (where is X, what files are related, what breaks if I change Y, usages, cycles, orphans) use `skills/gdgraph/SKILL.md` first, before broad raw file search. The user does not need to request graph usage explicitly.
6. In parallel, use `skills/gdctx/SKILL.md` for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output. The user does not need to request compact context usage explicitly.
7. For implementation, review, refactoring, planning, documentation, or quality tasks, check `skills/catalog.md` and project-local gdskills before any external/global skill set.
8. For known modules/components/stores/services/domain entities, check generated project skills under `project-skills/<module>/<entity>/` before generic guidance.
9. For code quality status (lint, type, test, coverage, complexity, gate, regressions), read `data/health/artifacts/latest.md` or run `gd-metapro health run`; do not claim quality status from raw logs.
10. For creating, changing, debugging, reviewing, or running tests, read `data/testing/context.md` and use `skills/testing/SKILL.md`; read `data/testing/artifacts/latest.md` before raw test logs.
11. For lessons learned, known decisions, constraints, repeated mistakes, historical context, or skill verification signals, use `skills/memory/SKILL.md` and `gd-metapro memory search` before broad documentation reads.
12. Use relevant skills from `skills/`.
13. Use module manifests before reading raw generated data.
14. Prefer curated artifacts in `data/*/artifacts`.
15. Run module CLI commands when generated data is stale.

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/queries/latest.md`
- `data/gdctx/artifacts/latest.md`
- `skills/catalog.md`
- `skills/gdskills/`
- `project-skills/`
- `data/gdskills/artifacts/latest.md`
- `data/health/artifacts/latest.md`
- `data/testing/context.md`
- `data/testing/recommendations.md`
- `data/testing/artifacts/latest.md`
- `memory/index.md`
- `data/memory/index/index.json`
- `data/memory/artifacts/latest.md`

## Refresh

```bash
gd-metapro index refresh
gd-metapro gdgraph build
gd-metapro test analyze
gd-metapro memory index
```

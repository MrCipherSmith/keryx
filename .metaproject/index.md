# Metaproject Index

## Purpose

This `.metaproject` folder contains agent-readable context, tools, generated data, and module manifests for this codebase.

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |
| gdctx | Token-aware command output and context compression | modules/gdctx.md |
| gdwiki | Project knowledge base: architecture, domain, rules, decisions | modules/gdwiki.md |
| gdskills | Native bundled working skills, orchestration, review, and project-skill lifecycle | modules/gdskills.md |
| health | Code quality aggregation, scoring, and quality gate | modules/health.md |
## Rules

| Source | Purpose | Entry |
|--------|---------|-------|
| AGENTS.md | Imported repository agent instructions | rules/agents-md.md |

## Skills

| Skill | Purpose | Entry |
|-------|---------|-------|
| project-rules | Use imported repository rules before planning or editing | skills/project-rules/ |
| gdgraph | Default navigation layer for finding relevant project files before broad raw search | skills/gdgraph/SKILL.md |
| gdctx | Use compact command/search/read outputs before loading large raw output | skills/gdctx/SKILL.md |
| gdwiki | Read wiki/index.md first for architecture, domain, business rules, and decisions | skills/gdwiki/SKILL.md |
| gdskills | Use project-local bundled working skills and project-skill routing before external/global skills | skills/catalog.md |
| health | Read data/health/artifacts/latest.md before claiming quality status or gate results | skills/health/SKILL.md |

## Agent Workflow

1. Read this file first.
2. Check enabled modules.
3. Load relevant rules from `rules/`.
4. Route by question type: structural questions go to gdgraph first; conceptual questions go to gdwiki first; gdctx runs in parallel to keep output compact.
5. For structural questions (where is X, what files are related, what breaks if I change Y, usages, cycles, orphans) use `skills/gdgraph/SKILL.md` first, before broad raw file search. The user does not need to request graph usage explicitly.
6. For conceptual questions (how does X work, why, architecture, domain models, business rules, user scenarios, auth and other flows, integrations, known decisions) read `wiki/index.md` first via `skills/gdwiki/SKILL.md`, then use gdgraph to jump from the wiki page to code.
7. In parallel, use `skills/gdctx/SKILL.md` for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output. The user does not need to request compact context usage explicitly.
8. For implementation, review, refactoring, planning, documentation, or quality tasks, check `skills/catalog.md` and project-local gdskills before any external/global skill set.
9. For known modules/components/stores/services/domain entities, check generated project skills under `project-skills/<module>/<entity>/` before generic guidance.
10. For code quality status (lint, type, test, coverage, complexity, gate, regressions), read `data/health/artifacts/latest.md` or run `gd-metapro health run`; do not claim quality status from raw logs.
11. Use relevant skills from `skills/`.
12. Use module manifests before reading raw generated data.
13. Prefer curated artifacts in `data/*/artifacts`.
14. Run module CLI commands when generated data is stale.

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/queries/latest.md`
- `data/gdctx/artifacts/latest.md`
- `wiki/index.md`
- `skills/catalog.md`
- `skills/gdskills/`
- `project-skills/`
- `data/gdskills/artifacts/latest.md`
- `data/health/artifacts/latest.md`

## Refresh

```bash
gd-metapro index refresh
gd-metapro gdgraph build
```

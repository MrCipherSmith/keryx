---
name: entity-skill-router
description: Use when select relevant project-skills for known modules, components, stores, services, and domain entities.
---

<!-- keryx:execution-metrics:begin -->
## Execution Metrics (user-direct opt-in)

When this skill is invoked directly by a user, before task work:

1. Read `.metaproject/rules/core/execution-metrics.md`.
2. Ask exactly: **Collect execution statistics for this run? (yes / no)**
3. Wait for the answer. If yes, follow the rule's reporting and persistence contract; if no, continue normally.

When dispatched as a subagent, do not ask and do not emit a separate report. The top-level caller owns metrics.
<!-- keryx:execution-metrics:end -->

# entity-skill-router

## Purpose

Select relevant project-skills for known modules, components, stores, services, and domain entities.

## When To Use

- project skill
- component pattern
- module-specific work

## Workflow

1. Check `.metaproject/project-skills` for matching module/entity skills.
2. Use gdgraph affected context to find nearby entities when the target is a file.
3. Load only the matching project-skill and directly referenced files.
4. If no project-skill exists, suggest creating one with `keryx skills generate`.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

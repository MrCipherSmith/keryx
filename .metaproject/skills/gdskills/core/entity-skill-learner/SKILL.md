---
name: entity-skill-learner
description: Use when update project-skills from review findings, test failures, health reports, memory entries, and verifier reports.
---

<!-- keryx:execution-metrics:begin -->
## Execution Metrics (user-direct opt-in)

When this skill is invoked directly by a user, before task work:

1. Read `.metaproject/rules/core/execution-metrics.md`.
2. Ask exactly: **Collect execution statistics for this run? (yes / no)**
3. Wait for the answer. If yes, follow the rule's reporting and persistence contract; if no, continue normally.

When dispatched as a subagent, do not ask and do not emit a separate report. The top-level caller owns metrics.
<!-- keryx:execution-metrics:end -->

# entity-skill-learner

## Purpose

Update project-skills from review findings, test failures, health reports, memory entries, and verifier reports.

## When To Use

- learn from review
- update skill
- skill lesson

## Workflow

1. Parse the source report and map findings to project-skills.
2. Classify lessons as anti-patterns, checklist changes, template changes, workflow changes, or architecture rules.
3. Respect manual sections and autonomy policy.
4. Increment version and append `skill-changelog.md` entries with provenance.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

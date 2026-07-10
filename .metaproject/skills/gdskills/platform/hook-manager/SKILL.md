---
name: hook-manager
description: Use when create and verify lightweight git hooks for graph, health, and skill verification.
---

<!-- keryx:execution-metrics:begin -->
## Execution Metrics (user-direct opt-in)

When this skill is invoked directly by a user, before task work:

1. Read `.metaproject/rules/core/execution-metrics.md`.
2. Ask exactly: **Collect execution statistics for this run? (yes / no)**
3. Wait for the answer. If yes, follow the rule's reporting and persistence contract; if no, continue normally.

When dispatched as a subagent, do not ask and do not emit a separate report. The top-level caller owns metrics.
<!-- keryx:execution-metrics:end -->

# hook-manager

## Purpose

Create and verify lightweight git hooks for graph, health, and skill verification.

## When To Use

- install hook
- git hook
- post-commit

## Workflow

1. Install hooks only when explicitly enabled.
2. Keep hooks lightweight and idempotent.
3. Avoid network and destructive behavior inside hooks.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

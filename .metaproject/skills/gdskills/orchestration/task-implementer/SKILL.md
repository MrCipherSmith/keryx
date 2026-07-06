---
name: task-implementer
description: Use when implement one atomic task end to end using local project context and verification.
---

# task-implementer

## Purpose

Implement one atomic task end to end using local project context and verification.

## When To Use

- implement task
- execute task
- atomic task

## Workflow

1. Read the task contract and selected context.
2. Plan a small implementation slice.
3. Edit only the required files and preserve unrelated changes.
4. Run focused verification and report modified files, tests, and residual risks.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

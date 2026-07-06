---
name: review-style
description: Use when review naming, readability, duplication, dead code, and maintainability.
---

# review-style

## Purpose

Review naming, readability, duplication, dead code, and maintainability.

## When To Use

- style review
- readability
- clean up

## Workflow

1. Focus on clarity and local consistency.
2. Separate style findings from correctness findings.
3. Avoid subjective churn unless it affects maintainability.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

---
name: review-strict
description: Use when perform a strict meta-review over findings, weak assumptions, and residual risk.
---

# review-strict

## Purpose

Perform a strict meta-review over findings, weak assumptions, and residual risk.

## When To Use

- strict review
- meta review
- boss review

## Workflow

1. Re-check high-impact assumptions.
2. Drop weak findings and elevate concrete risks.
3. Ensure final output is actionable and severity-ranked.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

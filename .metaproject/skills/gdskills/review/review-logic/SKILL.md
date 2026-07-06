---
name: review-logic
description: Use when review logic correctness, contracts, edge cases, nullability, and async behavior.
---

# review-logic

## Purpose

Review logic correctness, contracts, edge cases, nullability, and async behavior.

## When To Use

- logic review
- bug review
- correctness

## Workflow

1. Trace behavior through call sites and affected context.
2. Look for incorrect assumptions, missing branches, race conditions, and error paths.
3. Ground every finding in source code.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

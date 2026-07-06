---
name: review-architecture
description: Use when review boundaries, dependency direction, layering, and abstraction stability.
---

# review-architecture

## Purpose

Review boundaries, dependency direction, layering, and abstraction stability.

## When To Use

- architecture review
- boundary review
- layering

## Workflow

1. Identify module boundaries and public surfaces.
2. Check dependency direction and leakage across layers.
3. Flag coupling that increases blast radius or blocks future changes.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

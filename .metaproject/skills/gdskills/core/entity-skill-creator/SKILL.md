---
name: entity-skill-creator
description: Use when create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.
---

# entity-skill-creator

## Purpose

Create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.

## When To Use

- create skill
- generate project skill
- new entity skill

## Workflow

1. Normalize the target into module, entity, files, symbols, and wiki references.
2. Collect evidence from gdgraph, gdctx, gdwiki, health, and memory when available.
3. Create a concise procedural `SKILL.md` with references/templates only when needed.
4. Create `skill-changelog.md` and mark generated sections clearly.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

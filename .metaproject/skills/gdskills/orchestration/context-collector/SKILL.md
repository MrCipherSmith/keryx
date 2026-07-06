---
name: context-collector
description: Use when build compact task context from graph, ctx, wiki, memory, health, project-skills, and selected files.
---

# context-collector

## Purpose

Build compact task context from graph, ctx, wiki, memory, health, project-skills, and selected files.

## When To Use

- collect context
- gather context
- build context

## Workflow

1. Start from the target question and list the minimum context needed.
2. Use gdgraph for relationships and gdctx for compact outputs.
3. Pull wiki, memory, health, and project-skills only when relevant.
4. Return a small context bundle with links, commands run, and confidence gaps.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

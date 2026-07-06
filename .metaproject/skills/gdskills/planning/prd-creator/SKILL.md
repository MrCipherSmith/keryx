---
name: prd-creator
description: Use when convert vague requests into structured PRD and acceptance criteria.
---

# prd-creator

## Purpose

Convert vague requests into structured PRD and acceptance criteria.

## When To Use

- create PRD
- product requirements
- specify feature

## Workflow

1. Extract users, goals, non-goals, constraints, and risks.
2. Ask clarifying questions when needed.
3. Write testable requirements and acceptance criteria.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

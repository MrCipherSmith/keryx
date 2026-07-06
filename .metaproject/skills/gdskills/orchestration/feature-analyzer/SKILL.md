---
name: feature-analyzer
description: Use when analyze a feature, module, branch, or migration area and produce an implementation map.
---

# feature-analyzer

## Purpose

Analyze a feature, module, branch, or migration area and produce an implementation map.

## When To Use

- analyze feature
- study module
- investigate branch

## Workflow

1. Identify the target area and compare current vs desired behavior.
2. Use graph and compact context before reading broad files.
3. Rank files by importance and risk.
4. Produce a concise map of changes, dependencies, tests, and risks.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

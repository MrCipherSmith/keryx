---
name: review-orchestrator
description: Use when route review requests to specialized reviewers and consolidate findings.
---

# review-orchestrator

## Purpose

Route review requests to specialized reviewers and consolidate findings.

## When To Use

- review code
- full review
- review changes

## Workflow

1. Detect changed scope and relevant review domains.
2. Use gdgraph affected context for exported symbols and shared surfaces.
3. Dispatch specialized review passes conceptually or as separate skill loads.
4. Report findings first, ordered by severity, with concrete file references.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

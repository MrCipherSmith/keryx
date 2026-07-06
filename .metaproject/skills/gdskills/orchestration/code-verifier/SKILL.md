---
name: code-verifier
description: Use when run and summarize verification gates: typecheck, lint, tests, build, imports, and changed-scope checks.
---

# code-verifier

## Purpose

Run and summarize verification gates: typecheck, lint, tests, build, imports, and changed-scope checks.

## When To Use

- verify code
- run checks
- quality gate

## Workflow

1. Detect available project scripts and tooling.
2. Run the narrowest reliable checks first.
3. Summarize failures as actionable file/line findings where possible.
4. Store raw output under Metaproject data when gdctx is available.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

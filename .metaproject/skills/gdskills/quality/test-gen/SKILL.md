---
name: test-gen
description: Use when generate tests for a file or module using local patterns and existing test stack.
---

# test-gen

## Purpose

Generate tests for a file or module using local patterns and existing test stack.

## When To Use

- generate tests
- write tests
- add coverage

## Workflow

1. Discover test framework and nearby test examples.
2. Generate tests that cover behavior, edge cases, and errors.
3. Run focused tests when available.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.

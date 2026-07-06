---
name: metaproject-init-command
description: Use when working with src/commands/init.ts in module metaproject; prefer this project-local skill before generic guidance.
---

# Init Command Skill

Version: 0.1.0
Target: src/commands/init.ts
Module: metaproject
Status: active
Last Verified: 2026-07-06T18:48:52.635Z

## Purpose

Provide project-local guidance for creating, changing, reviewing, and verifying work related to `src/commands/init.ts`.
Read `references/context.md` for the initial evidence snapshot when details are needed.

## When To Use

- The task mentions `src/commands/init.ts`, `init-command`, or module `metaproject`.
- The task changes nearby files, stores, components, services, tests, or domain rules.
- The agent needs local patterns before applying generic implementation guidance.

## Evidence

<!-- gdskills:generated:start section="evidence" source="target,gdgraph,gdctx,gdwiki" -->
- Target kind: `file`
- Target exists: `true`
- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`
- `.metaproject/data/gdctx/artifacts/latest.md`
- `.metaproject/wiki/index.md`
<!-- gdskills:generated:end -->

## Files To Read

<!-- gdskills:generated:start section="files-to-read" source="target" -->
- `src/commands/init.ts`
<!-- gdskills:generated:end -->

## Architecture Rules

- Preserve the existing module boundaries around `metaproject`.
- Check graph affected context before changing public exports, shared stores, service APIs, adapters, or templates.
- Keep reusable logic in the established local layer instead of adding cross-module coupling.

## Business Rules

- Read related wiki pages before changing user-visible behavior or domain decisions.
- If wiki coverage is missing, document the discovered rule in gdwiki or Documentation Memory after implementation.

## Implementation Patterns

- Start from existing nearby files and tests.
- Use gdctx for compact reads, command output, diffs, and logs before loading large raw files.
- Keep changes scoped to the target entity and directly affected collaborators.

## Create Workflow

1. Resolve the exact target and related files through gdgraph or compact search.
2. Read this skill and the generated context reference when present.
3. Identify local patterns from neighboring implementation and tests.
4. Ask only for missing product or domain decisions that cannot be inferred.
5. Implement the smallest coherent change and run focused verification.

## Refactor Workflow

1. Build affected context before moving or renaming files.
2. Preserve public contracts unless the task explicitly changes them.
3. Update tests, wiki, memory, and this skill when the pattern changes.

## Questions To Ask

- What behavior or contract changes, if any?
- Should this follow an existing entity pattern or introduce a new one?
- Which tests or scenarios prove the change?

## Testing Rules

- Prefer nearby tests and module-level conventions.
- Cover behavior, edge cases, and regression risks that match the change.
- Record unavailable verification in the final answer.

## Review Checklist

- Target and affected files were found through Metaproject context tools before broad search.
- Local architecture and business rules were checked.
- Tests or explicit verification evidence exist.
- Skill updates are proposed when implementation reveals a reusable pattern or mistake.

## Anti-patterns

- Duplicating module-specific rules into unrelated modules.
- Editing generated or runtime-only artifacts as the canonical source.
- Treating this skill as fresher than source code when verification is stale.

## Review Lessons

- No review lessons recorded yet.

## Verification

- Current state: not verified.
- Run: `gd-metapro skills verify metaproject/init-command`

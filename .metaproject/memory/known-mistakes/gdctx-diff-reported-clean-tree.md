# keryx ctx diff reported a clean tree while three files were modified

Version: 0.1.0
Type: known-mistake
Status: draft
Confidence: high

## Summary

`keryx ctx diff --stat` printed `Changed files: 0` / `Untracked files: 0` while
`git status --short` listed three modified files, one of them holding a mutation
a killed script had left behind. The routed context layer said the tree was
clean at the exact moment it was not.

## Details

Observed on 2026-08-06 during flow 138, on branch
`fix/flow138-saved-permission-keryx-wildcard`.

A mutation-testing script was killed by a command timeout partway through, which
left `src/lib/shell-permissions.ts` holding an injected `if (false) {` — a
deliberately broken guard. Checking the working tree before committing:

- `keryx ctx diff --stat` → `Changed files: 0`, `Untracked files: 0`,
  `(no hunk headers)`. The underlying command it reported running was
  `git diff --stat HEAD`.
- `git status --short` (same cwd, same moment) → three modified files:
  `docs/docs/guides/contain-an-agent.md`,
  `src/lib/shell-permissions-hardening.test.ts`, `src/lib/shell-permissions.ts`.
- `git diff --numstat` → `22/2`, `95/2`, `122/16` on those three files.

The contradiction was only caught because a `keryx ctx rg` for `if (false)` in
the same breath returned a hit, which cannot be true of a clean tree. Without
that second question the mutated guard would have been committed and pushed,
with the routed diff as the evidence that it was fine.

Two things worth separating:

1. **The tooling defect.** Whatever `keryx ctx diff` did, it did not report what
   `git diff --stat HEAD` reports. It has not been root-caused; the raw log it
   references is at `.metaproject/data/gdctx/raw/`. Reproduce before trusting
   any conclusion about the cause.
2. **The practice.** A summarising layer that is wrong about *emptiness* fails
   silently, because "nothing to see" is indistinguishable from "nothing was
   looked at". Before a commit that follows destructive tooling — mutation runs,
   sed/awk rewrites, killed scripts — confirm the tree with a command whose
   failure mode is loud.

The same run produced the second half of the lesson: the mutation script had no
restore-on-signal handler, so a `SIGTERM` from the harness timeout left the
source broken. It now restores in `atexit` and on `SIGTERM`/`SIGINT`.

## Provenance

- Source: manual
- Link: flow 138 / PR #254
- Created: 2026-08-06
- Updated: 2026-08-06

## Related Scopes

- Module: gdctx
- Entity: ctx diff
- Files: src/commands/ctx.ts, src/lib/shell-permissions.ts
- Skills: gdctx

## Tags

gdctx, tooling, false-negative, working-tree, mutation-testing

## Changelog

- 0.1.0 - Initial version.

# Revision query mutation verification

A disposable filesystem copy of the current `apps/hub-web` was made, including the parent agent's uncommitted source and tests, with only `node_modules` linked. Baseline `bun run test -- tests/revision-pagination.case.tsx` in the original worktree: 5 passed. Each mutant below was applied independently in the copy and the same command run; no working-tree source was modified.

- W1-011 / `w1-supplement-revision-project-override`: exact current anchor `const projectId = projectOverride ?? hub.projectId;` in `src/features/revisions-query.tsx` replaced with `const projectId = hub.projectId;`. Exit 1: `revision pages use the explicit project even when another Hub project is selected` failed its request-path assertion (1 failed, 4 passed).
- W1-012 / `w1-supplement-exact-error`: the original reviewed anchor `error={revisions.error || project.error || exact.error}` was relocated by the redundancy fix. The equivalent current anchor `revisions.error || project.error || (!listed && exact.error)` in `src/features/context.tsx` was replaced with `revisions.error || project.error`, removing the exact-error contribution. Exit 1: `an exact revision lookup failure remains visible when list and project reads succeed` failed (1 failed, 4 passed). This was a behavioral equivalent mutation, not a claim that the stale old anchor applied.

Full current web suite: `bun run test` from `apps/hub-web` passed 43 files, 217 tests. No network, installs, commits or main source edits.

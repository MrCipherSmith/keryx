# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The stop gate never reads the mutation scratch directory: with files under `<root>/.metaproject/data/review/mutate-scratch/`, `findReviewGateState` returns the same signature as without them and `hashedFileCount()` does not grow by any of them. · sensitive: revert [verify: exec `bun test src/review/completion-gate.test.ts`]
- AC2: One gate evaluation hashes at most `MAX_SIGNATURE_FILES` files per walked tree: on a package tree larger than the budget the walk stops at the budget, the signature carries a truncation marker and is identical on a second call over the unchanged tree, and the second call hashes no file again. · sensitive: revert [verify: exec `bun test src/review/completion-gate.test.ts`]
- AC3: `findReviewGateState` honours an AbortSignal: with an aborted signal it rejects with an `AbortError` and hashes no file. · sensitive: revert [verify: exec `bun test src/review/completion-gate.test.ts`]
- AC4: Failure scenario — an aborted turn in a session with an open managed review package gets no review-gate nudge, because `holdReviewGate` passes the turn's signal and returns false when it is aborted; a non-aborted turn is still held as before. · sensitive: failure-scenario [verify: exec `bun test src/commands/agent-review-gate.test.ts`]
- AC5: The mutation pass copies no nested git checkout: a nested worktree (a `.git` file whose `gitdir:` points at `…/worktrees/…`) and an embedded clone (a `.git` directory) are absent from the scratch copy, while a submodule (a `.git` file pointing at `…/modules/…`) and ordinary directories are copied. · sensitive: revert [verify: exec `bun test src/review/mutate.test.ts`]
- AC6: Failure scenario — a pass removes scratch left by dead passes: under the scratch base, a `keryx-mutate-XXXXXX` directory whose `owner.json` names a dead pid, or that has no owner marker and is older than the stale age, is removed; one owned by a live pid, a fresh unmarked one, and a non-matching name (`keryx-mutate-test-…`) are kept; every new pass writes its own `owner.json`. · sensitive: failure-scenario [verify: exec `bun test src/review/mutate.test.ts`]
- AC7: Typecheck passes on the changed code. [verify: exec `bun run typecheck`]
- AC8: Before/after on a fixture repository with a large `mutate-scratch` and a nested worktree: one gate evaluation with the new code hashes no scratch file and stays within the budget, where the old code reads every file; the numbers are recorded in `journal.md`. [verify: judged]

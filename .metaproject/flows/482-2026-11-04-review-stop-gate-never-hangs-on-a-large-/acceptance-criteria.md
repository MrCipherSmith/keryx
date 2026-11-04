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
- AC5: The mutation pass copies no linked worktree: a nested directory whose `.git` file points at a linked worktree's git directory (`…/.git/worktrees/…`, also under a path with a `modules` segment, or a git directory holding `commondir`) is absent from the scratch copy, while a submodule (a `.git` file pointing at `…/modules/…`, or a path listed in `.gitmodules`), an embedded clone (a `.git` directory) and ordinary directories are copied as before; the repository's own mutate-scratch is never copied, also with `--scratch tmp`. · sensitive: revert [verify: exec `bun test src/review/mutate.test.ts`]
- AC6: Failure scenario — a pass removes scratch left by dead passes and nothing else: under the scratch base (and the repository's own mutate-scratch when the base is elsewhere), a `keryx-mutate-XXXXXX` directory the operator owns is removed when its `owner.json` names a dead pid and was not refreshed for two heartbeats, when its `owner.json` was not refreshed for the stale heartbeat age whatever its pid, or when it has no readable owner marker and is older than the stale age; one with a fresh heartbeat, a fresh unmarked one, one owned by another user, a non-directory and a non-matching name (`keryx-mutate-test-…`) are kept, and a marker that is a FIFO or oversize does not stall the sweep; every pass writes its own `owner.json` and refreshes it while it runs. · sensitive: failure-scenario [verify: exec `bun test src/review/mutate.test.ts`]
- AC7: Typecheck passes on the changed code. [verify: exec `bun run typecheck`]
- AC8: Before/after on a fixture repository with a large `mutate-scratch` and a nested worktree: one gate evaluation with the new code hashes no scratch file and stays within the budget, where the old code reads every file; the numbers are recorded in `journal.md`. [verify: judged]

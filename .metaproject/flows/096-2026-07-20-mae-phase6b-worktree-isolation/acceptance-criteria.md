# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `needsWorktree(policy, allowedActions)` in `src/harness/child/worktree.ts` returns true exactly when `requiredControls.isolation === "required-fail-closed"` AND the allowed actions include `write` or `git`; read-only or non-isolated tasks return false. Pure.
- AC2: `planWorktrees(tasks)` is pure/deterministic: each isolation-required mutator gets a unique, stable worktree id (derived from taskId, no RNG); every other task maps to the shared cwd; identical input yields a deep-equal plan.
- AC3: Fail-closed — an isolation-required mutator that cannot be assigned a worktree is denied (never silently assigned the shared cwd).
- AC4: An injected `WorktreePort` (create/remove/merge) drives the lifecycle; a fake port test proves the order create → child cwd set from the assignment → post-wave merge (in a defined, stable order), with `resolveChildCwd` feeding `ContainedCommand.cwd`.
- AC5: `worktree.test.ts` covers the needsWorktree matrix, plan determinism + uniqueness, fail-closed denial, and the fake-port lifecycle; the full suite (incl. the zero-`dependencies` guard) passes and `tsc --noEmit` is clean; no new runtime dependency is added.

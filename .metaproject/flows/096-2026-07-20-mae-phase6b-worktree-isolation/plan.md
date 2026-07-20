# Implementation Plan

Status: ready to freeze

## Approach

Split the concern: a PURE assignment planner (deterministic, unit-tested) plus an
injected `WorktreePort` for the impure git lifecycle (faked in tests, thin real
adapter for runtime). The `cwd` seam already exists on the contained command.

## Steps

1. New `src/harness/child/worktree.ts`:
   - `interface WorktreePort { create(id): Promise<{path}>; remove(id): Promise<void>;
     merge(id, into): Promise<{ok, conflicts?}>; }`
   - `needsWorktree(policy, allowedActions)` — true when isolation is
     required-fail-closed AND actions include write/git.
   - `planWorktrees(tasks) → { assignments: Map<taskId, worktreeId>; shared: taskId[] }`
     — deterministic; isolation-required mutators get a unique worktree id, others
     the shared cwd; fail-closed if an isolation-required mutator cannot be assigned.
   - `resolveChildCwd(assignment, sharedCwd)` — feeds `ContainedCommand.cwd`.
2. New `src/harness/child/worktree.test.ts`: needsWorktree matrix, plan
   assignment (determinism, unique paths, shared for read-only), fail-closed
   denial, and lifecycle via a fake `WorktreePort` (create→cwd→merge order).
3. Wire the `cwd` from an assignment into the child run input (behind the port);
   real adapter (`git worktree add/remove`) covered by a smoke test if feasible.

## Risks

- Keep `planWorktrees` PURE and deterministic (unique ids from taskId, not RNG).
- Isolation-required-but-unassigned MUST fail closed (never fall back to shared cwd).
- Real git lifecycle stays behind the port; determinism tests use the fake.
- Merge order must be defined and stable (by taskId) to stay deterministic.

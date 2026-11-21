# Worktree readiness stage 1: create/prepare/promote, env, deps, ports, indexes, agent root lines

## Problem
A bare `git worktree add` gives a checkout with no `.env` files, no `node_modules`,
the same ports as the main checkout, no memory index, and an agent that may not
know the worktree's absolute root. Findings made in a worktree are lost when it is
removed. Spec: `docs/requirements/keryx-worktree-readiness/` (PR #1259), stage 1
of `implementation-plan.md` = requirements R1-R6.

## Expected Outcome
`keryx worktree create|prepare|promote|env|exec|status|remove` exist (module
`src/worktree/`). A new worktree gets `.env` files (gitignored only), dependencies
(copy-on-write, lock-hash skip), per-worktree ports, a rebuilt memory index, and a
checkout label in its own git dir. `promote` moves findings into the user area under a
lock. Sessions, subagents (`provisionWorktrees`), external agents and `trigger run`
tell the agent the worktree root and index path. `keryx doctor`'s `worktrees` check
shows label, ports, prepare state and unpromoted entries. `keryx trigger run` creates
its worktree through `src/worktree`.

## Outcome criteria
- Time from `keryx worktree create` to a first green `bun test src/lib` in the new
  worktree, measured by the owner on the next flows (not measured here).

## Out of Scope
Stages 2-4: `headBranch`/`worktree` fields in flow.json, `worktree check`, baseline,
flaky retry, Desktop UI. Releasing. RP-08 SAC. Merging the PR.

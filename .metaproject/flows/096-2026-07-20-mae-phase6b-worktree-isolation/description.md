# Multi-Agent Engine Phase 6b: worktree isolation for parallel mutators

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/ (brainstorm C3, roadmap Phase 6)

## Problem

`planWaves` can schedule read-only children concurrently, but children that WRITE
or run `git` cannot safely run in parallel — they collide in the shared working
tree. Today the engine has no way to give each mutating child an isolated repo
copy, so parallel mutation is unsafe and effectively serialized.

## Expected Outcome

A pure **worktree assignment planner** — `planWorktrees(tasks, policy) →
assignments` — that assigns a dedicated git-worktree path to each wave-scheduled
child whose policy requires isolation (`requiredControls.isolation:
required-fail-closed`) AND whose allowed actions include write/git; read-only
children keep the shared cwd. Plus an injected `WorktreePort` (create/remove/
merge) so the lifecycle is testable offline (real git behind the port), and the
`ContainedCommand.cwd` seam is set from the assignment. Parallel writers stop
colliding; merge is an explicit, ordered post-wave step. Fail-closed: an
isolation-required child with no worktree assignment is denied, never run in the
shared tree.

## Out of Scope

- Event-sourced fold (Phase 6a, flow 095) and peer messaging (Phase 6c, flow 097).
- Actually invoking real `git worktree` in tests — the `WorktreePort` is injected
  and faked; a thin real adapter is wired but exercised via smoke/isolation, not
  unit determinism.
- Conflict RESOLUTION policy beyond detecting/merging in a defined order.

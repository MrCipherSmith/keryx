# Execution Metrics — flow 109

Collected at the user's request (`rules/core/execution-metrics.md` opt-in).

## Run

| | |
|---|---|
| Flow | 109 — TUI transcript blocks |
| Orchestrator | flow-orchestrator (Claude Opus 4.8) |
| Wall clock | ~2h10 (16:22 → 18:32 UTC, 2026-07-21) |
| Tasks | 6 (T1 context, T2 test, T3 implement, T4 implement, T5 test/docs, T6 fix) |
| Acceptance criteria | 14, all confirmed |
| Commits | 10 on `feat/tui-transcript-blocks` |
| PR | https://github.com/MrCipherSmith/keryx/pull/185 (draft) |

## Worker dispatches

| # | Task | Worker role | Outcome | Subagent tokens | Tool uses |
|---|---|---|---|---|---|
| 1 | T1 | context-collector | DONE | 152,185 | 45 |
| 2 | T2 | tests-creator | DONE_WITH_CONCERNS | 91,126 | 31 |
| 3 | T3 | task-implementer | DONE | 100,834 | 33 |
| 4 | T4 | task-implementer | interrupted by the user mid-run | not reported | — |
| 5 | T4 | task-implementer (re-dispatch) | DONE_WITH_CONCERNS | 131,160 | 54 |
| 6 | T5 attempt 1 | tests-creator | BLOCKED (tree stashed by a concurrent session) | 117,135 | 42 |
| 7 | T5 attempt 2 | tests-creator | BLOCKED (branch switched by a concurrent session) | 137,989 | 65 |
| 8 | T5 attempt 3 | tests-creator (in worktree) | DONE_WITH_CONCERNS | 190,597 | 126 |
| 9 | — | review-orchestrator | DONE_WITH_CONCERNS | 175,012 | 53 |
| 10 | T6 | task-implementer (in worktree) | DONE | 176,661 | 111 |

**Total reported subagent tokens: ~1,272,699** across 9 completed dispatches
(560 tool uses), plus one interrupted dispatch that is not accounted for.

## Waste

Three dispatches (#4, #6, #7 — roughly **255k tokens plus the unreported
interrupted run**, ~20% of the total) produced no accepted deliverable. All three
were lost to environment interference, not to bad work:

- #4 was interrupted by the user, but had already written most of T4 to disk;
  #5 verified rather than rewrote it, which converted the loss into a review risk
  instead of a rewrite cost. That risk was then discharged by dispatch #9.
- #6 and #7 were killed by concurrent agent sessions stashing the working tree
  and switching branches in the shared checkout.

Moving to an isolated git worktree (before #8) ended the interference: the three
dispatches that ran there (#8, #9, #10) all completed, and were also the three
largest by tool use.

## Quality signals

| | |
|---|---|
| Tests before flow | 1,972 pass / 11 skip / 0 fail |
| Tests after flow | 2,012 pass / 11 skip / 0 fail (+40) |
| Typecheck | clean throughout |
| Review findings | 1 HIGH, 3 MEDIUM, 5 LOW — all fixed |
| New runtime dependencies | 0 (`package.json` / `bun.lock` diffs empty) |
| Deliberate deferrals | 2, both recorded with reasons |

The single HIGH finding (a CRLF fence regression) was introduced in T3 and
survived T4 and T5 — it was caught only by the dedicated review pass, which had
been flagged as extra-load-bearing because T4's code was authored by an
interrupted worker. The review paid for itself.

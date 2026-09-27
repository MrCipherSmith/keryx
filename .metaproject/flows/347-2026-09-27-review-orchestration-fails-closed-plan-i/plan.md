# Implementation Plan

Status: approved by the user in chat ("run the flow on all 9 items", 2026-09-27)

## Approach

Fix the mechanisms in place; no new subsystems. The analysis session already
located every site (see context.md), so tasks go straight to implementation.
Work is split into lanes by file so parallel workers never edit the same file:

| Lane | Files | Tasks |
|---|---|---|
| A — turn loop | `src/commands/agent.ts`, `src/session/execution-plan.ts` | T5 → T6 (sequential, same file) |
| B — subagent | `src/harness/tool/builtin/spawn-subagent-tool.ts` (+ the budget branch in `agent.ts`, after lane A) | T7 → T8 |
| C — reviewer inventory | `src/review/reviewers.ts`, `src/commands/review.ts` (reviewers branch) | T9 |
| D — skill + rule text | `review-orchestrator/SKILL.md` (bundled + `.metaproject` copy, parity-tested), `session-plan-bridge.mdc` (both copies) | T10 |

Lanes A, C, D start in parallel. Lane B starts after T6 because T7 edits the budget
branch of `agent.ts`. T11 verifies end to end, T12 reviews.

Key decisions:

- **Plan follow-through** becomes opt-in through an explicit turn dependency
  (default off). With it off, a turn ending with actionable items prints a
  `system()` line for the operator and returns. The system-prompt text stops tying
  plan state to when a turn may end.
- **Nudge envelope.** Provider APIs require user/assistant alternation, so the role
  stays `user`; the message gets a dedicated provenance (e.g. `harness`) and a
  consistent envelope that names the shell as the author. Applies to the plan nudge
  (when opted in) and the toolless reprompt.
- **Budget wrap-up** reuses the existing wrap-up path (`finishWithBudgetSummary`)
  that the no-progress branch already uses, rather than adding a second one.
- **Subagent `cwd`** is validated by realpath: it must be the project root, a
  descendant of it, or a path `git worktree list` reports for the same repository.
- **Reviewer inventory** falls back to the review skills shipped in the installed
  package when the project copy is absent, and reports the source; with neither it
  reports `not-found` and exits non-zero.

## Steps

1. T5 — plan follow-through opt-in, snapshot order, prompt wording (items 1, 3).
2. T6 — toolless reprompt narrowing + nudge envelope (items 8, 9).
3. T7 — tool-call budget wrap-up round + `BudgetExhausted` surfaced (item 2).
4. T8 — `spawn_subagent` `cwd` (item 6).
5. T9 — reviewer inventory source + `not-found` (item 7).
6. T10 — review-orchestrator fail-closed gate, publication draft gate, bridge
   timing; document the `BudgetExhausted` line and `cwd` (items 4, 5).
7. T11 — verification: typecheck, targeted tests, a live `keryx harness run` with a
   scripted provider showing the budget wrap-up and a plan-ending turn without
   injection.
8. T12 — review-orchestrator review of the branch diff.

## Risks

- Existing tests assert the follow-through nudge and reprompt text; they change
  with the behaviour and must be updated, not deleted.
- `/goal` relies on continuation behaviour; the opt-in must keep `/goal` flows
  working (check `goal-command.ts`).
- The installed `keryx` on PATH is stale; verification runs the working tree
  (`bun run src/cli.ts …`), not `keryx`.
- Other sessions work on `agent.ts` on main; rebase before the PR.

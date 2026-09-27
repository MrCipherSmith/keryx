# Review orchestration fails closed: plan is display-only, exhausted subagents report, reviewer inventory and publication are checked

Status: formalized
Source: user description — incident analysis of a `review-orchestrator` run in keryx shell 0.3.14 (session model `openai-codex/gpt-6-sol`) on a downstream frontend project, cross-checked against the code at `0b7fc0b6`.

## Problem

A managed review round in keryx shell reported itself complete while three of five
reviewers returned nothing, the verifier returned nothing, the orchestrator wrote
its own findings, and a weak comment was posted to the pull request. Two reports
(the agent's self-report and an independent one) traced it to keryx mechanisms that
let the failure pass, not only to model error:

1. **The session plan steers the turn.** `agent.ts` injects a `role: "user"` message
   "[system] The current execution plan still has actionable items remaining…" when
   the model tries to end the turn with `pending`/`in_progress` items, and the system
   prompt announces that rule. The only way to end a turn is to tick every item, so
   the model batch-marked unverified steps `completed`. The `session-plan-bridge`
   rule calls the plan a projection that is "not a completion signal" — the code does
   the opposite.
2. **An exhausted subagent looks like an empty success.** On `max_tool_calls` the
   turn returns `tool-call-budget` immediately, with no wrap-up round. The parent's
   tool output says `(subagent produced no text)` and never says `BudgetExhausted`;
   the fleet event says `done`; the child slate folds as `completed`.
3. **The plan snapshot hides the current step.** `renderExecutionPlanSnapshot` shows
   the first 7 items in insertion order, so an 18-step plan always shows the finished
   steps 0–5 and hides the `in_progress` one.
4. **The review-orchestrator quality gate does not catch an empty reply.** No text,
   off-schema text or `BudgetExhausted` is not mapped to `BLOCKED`, there is no
   retry, and nothing forbids marking steps 8–10 `completed` without an ingested result.
5. **Publication is advisory.** The skill posts with `gh pr comment` straight after
   writing the body; no draft is shown to the user before the GitHub write, and the
   skill says "publish the checklist" at Step 0 while the bridge rule says after Step 6.
6. **A subagent cannot be pinned to a review worktree.** `spawn_subagent` always uses
   the parent's `cwd`, so a verifier read the base branch instead of the PR head.
7. **An empty reviewer inventory is indistinguishable from "no reviewers".**
   `keryx review reviewers` reads only `<root>/.metaproject/skills/gdskills/review` and
   returns `bundled: []` without error when that directory is absent (a review
   worktree carrying only `data/` and `reviews/`).
8. **The toolless reprompt fires on finished answers.** `modelClaimedAction` counts
   tokens like `i`, `will`, `сейчас`, and nothing checks whether this turn already ran
   tools or whether the reply is a complete, structured answer.
9. **Shell control nudges masquerade as the user.** Synthetic nudges are pushed as
   `role: "user"` with a literal `[system]` prefix; neither the model nor the
   transcript can tell them from operator input.

## Expected Outcome

- A turn with an unfinished session plan ends with the model's text reply and no
  injected message; the operator sees a one-line note instead. Auto-continuation on
  the plan exists only behind an explicit opt-in.
- The plan snapshot the model sees leads with the `in_progress` item and folds
  finished items into a count.
- A subagent that exhausts its tool-call budget gets one tool-free wrap-up round, and
  the parent's tool output starts with `status: BudgetExhausted (<n>/<m> calls)`;
  fleet and slate record it as partial, not done.
- `spawn_subagent` accepts a `cwd` confined to the project root (or one of its git
  worktrees); relative paths in the child resolve there.
- `keryx review reviewers` reports where its inventory came from and says
  `not-found` instead of returning empty lists silently.
- The toolless reprompt no longer fires after tool calls in the same turn or on a
  complete, structured answer.
- Shell-synthesized nudges carry a distinct provenance and envelope, so the model and
  the transcript can tell them from the operator.
- The `review-orchestrator` skill fails closed on empty/off-schema/exhausted reviewer
  results, forbids ticking steps 8–10 without an ingested artifact, shows the
  rendered report to the user before any GitHub write, and agrees with the bridge
  rule on when the checklist is published.

## Out of Scope

- Model-tier ranking for providers that report no models (`session-fallback`) —
  only the skill's reporting of it changes here.
- `slate_write_seed` failing with `no open slate`.
- A new keryx command that posts review comments; publication keeps `gh`, gated by
  the skill's draft-approval step.
- Enforcing plan status transitions in `plan_set` against review artifacts in code.

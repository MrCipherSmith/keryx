# Flow Journal

- 2026-11-24T16:19:57.525Z - flow created
- 2026-11-24T16:21:09.768Z - task-added: T5: Update implementation-plan.md: Fix findings done, deferred variant, not verified
- 2026-11-24T16:21:09.941Z - task-added: T6: Verify AC1-AC6 exec commands green
- 2026-11-24T16:21:10.131Z - frozen: 7 criteria; checksum recorded
- 2026-11-24T16:21:10.314Z - started
- 2026-11-24T16:21:10.488Z - task-done: T1: Collect remaining context
- 2026-11-24T16:21:20.759Z - task-attempt: T2: started (attempt 1) — 522-T2
- 2026-11-24T16:22:22.009Z - task-done: T5: Update implementation-plan.md: Fix findings done, deferred variant, not verified

## 2026-11-24 T2 accepted (DONE_WITH_CONCERNS)

- Orchestrator re-ran the AC1–AC5 suites (165 pass, 0 fail, 7 files) and `tsc --noEmit` (exit 0).
- Behaviour choices the worker flagged `needs_operator`. This run was started by another session with no operator present, so the implemented choices are kept and listed in the PR for the owner: (1) button in the panel header row, visible text "Fix findings", accessible name "Fix findings of pull request #N"; (2) a `stopped` Review whose older reviewed attempt has open findings stays eligible (only queued, running, needs_answer are refused, per the plan matrix); (3) three-line prompt wording.
- Signature: `fixFindingsPrompt(review, key, target)` instead of the plan's `(review, target, runId)`; the target carries runId, round and range.
- No separate ReviewsView pass-through test: the App fixture `app-fix-findings.fixture.tsx` covers it end to end.

## 2026-11-24 Review round 1 (PR #1311 @ 66e3e525f) — operator decision

- Major (review-logic F-001 = review-degradation F-001): on a PR that already has a Flow, the fix Flow is never offered for Link (bound session carries the `flow` flag or a new session is started via `workOnFlow`, so `resolveFlowLinks` drops the request; `PrWorkRow` hides offers while the PR has a Flow).
- Operator decision (claude-code AskUserQuestion, answered in this session): "Fix in existing Flow". When the PR has a Flow, the prompt asks flow-orchestrator to fix the findings as a fix round of that Flow in its session, with no new package and no Link offer; with no Flow, a new fix Flow with the Link offer as before.
- Minors/infos recorded as deferred (brief: fix only blockers and majors): architecture F-001 (minor, desktop copies the reference-attempt rule from review-entity.ts; suggested `referenceRunId` on ReviewSummary), logic F-002 (info, counts from `review.findings` vs attempt id), security F-001 (info, prompt values unquoted), layout LY-001 (info, 24px vs 28px header buttons), testing TP-1 (minor, model.test fixable() puts findings on the Review but not on its reference attempt), TP-2..TP-4 (info: short-SHA assertion weak, partial/budget and repositoryId unasserted, AC5 suites not in the saved verify-run), ui-ux UX-001 (minor, button in sheet-head-row rather than a sheet-actions row), UX-002 (info, prefill into an existing session may replace its unsent draft — pre-existing Create Flow behaviour). Mutation pass not run (21 candidates listed by testing-practices).
- 2026-11-24T16:28:07.304Z - task-done: T2: Implement per plan
- 2026-11-24T16:28:07.505Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-24T16:28:07.692Z - task-done: T6: Verify AC1-AC6 exec commands green
- 2026-11-24T16:37:16.866Z - ac-updated: AC4: "In the App, Fix findings from the Reviews tab opens the PR's bound session (a new bound one when none exists) with the findings prompt in the composer, not sent, and the one flow package that then appears is offered on the PR's work row as "Link Flow #N" and linked only on Link — the same path as Create Flow. Test through the App fixture or an equivalent App-level DOM test. [verify: exec `cd apps/desktop && bun test src/shell/ProjectNavigation.dom.test.tsx src/reviews/ReviewsView.dom.test.tsx`]" -> "In the App, Fix findings from the Reviews tab on a PR with no Flow opens the PR's bound session (a new bound one when none exists) with the findings prompt in the composer, not sent, and the one flow package that then appears is offered on the PR's work row as "Link Flow #N" and linked only on Link — the same path as Create Flow. On a PR that already has a Flow (by prUrl or a bound session's flow flag), it opens that Flow's session (the bound one, else a new session working on that Flow) with a prompt that asks flow-orchestrator to fix the findings as a fix round of Flow #N, not sent, and registers no pending link. Test through the App fixture, including a PR whose bound session already has a flow flag. [verify: exec `cd apps/desktop && bun test src/shell/ProjectNavigation.dom.test.tsx src/reviews/ReviewsView.dom.test.tsx`]" (Review round 1 major (logic F-001 / degradation F-001): on a PR that already has a Flow the fix Flow was never offered for Link; operator chose 'Fix in existing Flow' in this session)
- 2026-11-24T16:37:17.047Z - task-added: T7: Fix round R1: Fix findings on a PR that already has a Flow fixes in that Flow
- 2026-11-24T16:37:26.956Z - task-attempt: T7: started (attempt 1) — 522-T7
- 2026-11-24T16:42:14.726Z - task-done: T7: Fix round R1: Fix findings on a PR that already has a Flow fixes in that Flow

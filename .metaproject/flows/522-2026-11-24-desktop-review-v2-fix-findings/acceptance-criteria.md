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

- AC1: `fixFindingsTarget` returns a target only for a Review of the viewer's own open PR (author compared case-insensitively) that is not closed, archived, queued, running or awaiting an answer, has a finished reviewed attempt, and has at least one blocker, major or minor finding; a unit test covers each refusal (other author, closed or merged PR, no card, archived, running, only info findings, no reviewed attempt) and picks the newest unarchived reviewed attempt as the run. [verify: exec `cd apps/desktop && bun test src/reviews/model.test.ts`]
- AC2: `fixFindingsPrompt` names the PR URL, the round, the reviewed range, the open counts per severity, says info findings are left out, asks for a Keryx fix flow with flow-orchestrator, and contains the exact `keryx review desk-run status --json --repo … --repository-id … --viewer … --number … --id <runId>` command; a unit test asserts each part. [verify: exec `cd apps/desktop && bun test src/reviews/model.test.ts`]
- AC3: The Review panel shows a button with the visible text "Fix findings" only when the Review is eligible and the handler is given; pressing it calls the handler once with the PR card and the prompt; an ineligible Review (other author, only info findings, running) shows no such button. DOM test. [verify: exec `cd apps/desktop && bun test src/reviews/ReviewPanel.dom.test.tsx`]
- AC4: In the App, Fix findings from the Reviews tab on a PR with no Flow opens the PR's bound session (a new bound one when none exists) with the findings prompt in the composer, not sent, and the one flow package that then appears is offered on the PR's work row as "Link Flow #N" and linked only on Link — the same path as Create Flow. On a PR that already has a Flow (by prUrl or a bound session's flow flag), it opens that Flow's session (the bound one, else a new session working on that Flow) with a prompt that asks flow-orchestrator to fix the findings as a fix round of Flow #N, not sent, and registers no pending link. Test through the App fixture, including a PR whose bound session already has a flow flag. [verify: exec `cd apps/desktop && bun test src/shell/ProjectNavigation.dom.test.tsx src/reviews/ReviewsView.dom.test.tsx`]
- AC5: Create Flow on the PR card keeps its prompt and behaviour (existing tests unchanged and green). · sensitive: failure-scenario [verify: exec `cd apps/desktop && bun test src/review/prWork.test.ts src/review/PrWorkRow.dom.test.tsx src/review/usePendingFlowLinks.dom.test.tsx`]
- AC6: Desktop typecheck passes for the changed files. [verify: exec `cd apps/desktop && bunx tsc --noEmit -p .`]
- AC7: `docs/requirements/keryx-desktop-review-v2/implementation-plan.md` records the Fix findings action as done (Reviews panel), names what was deferred (PR-card variant on CHANGES_REQUESTED / unresolved threads) and what was not verified in the real app. [verify: judged]

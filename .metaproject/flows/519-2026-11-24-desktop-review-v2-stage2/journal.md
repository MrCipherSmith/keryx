# Flow Journal

- 2026-11-24T07:16:18.886Z - flow created
- 2026-11-24T07:19:14.810Z - task-done: T1: Collect remaining context
- 2026-11-24T07:19:15.191Z - task-done: T2: Implement per plan
- 2026-11-24T07:19:15.510Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-24T07:19:15.823Z - task-done: T4: Self-review and prepare draft PR
- 2026-11-24T07:19:16.212Z - task-added: T5: Store: reviews table, rounds and attempts, migration and its test, badge round with parity
- 2026-11-24T07:19:16.529Z - task-added: T6: Reviews read model, keryx review reviews --json, bridge arg and platform call
- 2026-11-24T07:19:16.834Z - task-added: T7: Reviews tab: navigation, board/list/filters, Review panel with the moved review interface, indicator
- 2026-11-24T07:19:17.196Z - task-added: T8: Pull requests board: indicator without local review, New review round label, F-024
- 2026-11-24T07:19:17.519Z - task-added: T9: Migration on a copy of the local working database
- 2026-11-24T07:19:17.861Z - task-added: T10: Test suites, typecheck and lint
- 2026-11-24T07:19:18.248Z - task-added: T11: Reviews toolbar measurement at 1100/760/560px
- 2026-11-24T07:19:18.561Z - task-added: T12: review-orchestrator on the PR
- 2026-11-24T07:19:18.913Z - task-added: T13: Implementation plan stage 2 state, deviation b closed, CLI reference
- 2026-11-24T07:19:31.529Z - frozen: 12 criteria; checksum recorded
- 2026-11-24T07:19:31.820Z - started
- 2026-11-24T07:19:40.519Z - task-attempt: T5: started (attempt 1) — 519-T5

## 2026-11-24 · T5 accepted (DONE_WITH_CONCERNS)

- Orchestrator re-ran `bun test src/review/desk-run-store.test.ts src/review/board-badges.test.ts` (46 pass, 0 fail) and `bun run typecheck` (clean).
- Concern: `desk-run-store.ts` is 854 lines (over the 800-line readability threshold). Moving the assignment logic to its own module is left as a follow-up.
- Concern: each writable open takes a short immediate lock for the migration check; it is covered by the 8 s busy_timeout.
- Concern: Desktop `badgesEqual` does not compare `outdated.round`. T8 handles this.
- Behaviour, as the plan specifies: a range that comes back after other ranges (A, B, A) rejoins its first round as a retry. A row without `createdAt` sorts first.
- `board-types.ts` touched: `outdated.round?` is required by `LocalBadge`.
- Worker saw `src/review/layers-payload.test.ts` time out under the full `src/review` run. That test does not import the changed files. CI will tell; not verified against base.

## 2026-11-24 · T9 migration on a copy of the local working database

`sqlite3 .backup` copy of `~/.local/share/keryx/desktop-review/runs.sqlite` into the session scratchpad (not committed), opened twice with the new writable store:
attempts before 17 / after 17; unassigned 0; reviews 13 = distinct (repo, pr, lower(viewer)) keys 13; dangling review ids 0; rounds: round 1 x 13, round 2 x 4. The second open changed nothing.
- 2026-11-24T07:37:04.175Z - task-attempt: T6: started (attempt 1) — 519-T6
- 2026-11-24T07:37:09.335Z - task-done: T5: Store: reviews table, rounds and attempts, migration and its test, badge round with parity
- 2026-11-24T07:37:09.572Z - task-done: T9: Migration on a copy of the local working database

## 2026-11-24 · T6 accepted (DONE_WITH_CONCERNS)

- Orchestrator re-ran the review-entity, review-reviews, store and badge tests (69 pass, 0 fail), plus root and Desktop typecheck (clean). Rust `review.rs` is unverified locally; CI only.
- Spec/plan disagreement on `budget`: the plan wins. A finished attempt with a reviewed range (completed, partial or budget) is `ready`/`published`.
- Response keeps `version: 1`, the same key the board uses, so Desktop's `assertProtocol` is shared. The spec's "raise the protocol version" is not done; new command, own payload.
- Comparisons run only for 40-char hex heads; `gh` returns only `status`/`ahead_by`; at most 25 per call, four at a time.
- Operator question raised: what freshness to show when the PR head is unknown (card unreadable or PR missing). The worker returns `current`. See the answer below.
- Rounds are listed newest first; state, source and latestRound come from the newest attempt; findings and publication from the newest finished, reviewed attempt.
- 2026-11-24T07:51:43.210Z - task-done: T6: Reviews read model, keryx review reviews --json, bridge arg and platform call
- 2026-11-24T07:51:43.524Z - task-attempt: T7: started (attempt 1) — 519-T7

## 2026-11-24 · Operator answer: freshness when the PR head is unknown

Answer (operator, AskUserQuestion in this session): add a freshness kind `unknown`. The card shows "head unknown" and the Review is not placed in Behind. This is a small spec change; it will be recorded in the plan's stage 2 state. It is implemented as a fix task on T6 output, together with T8.

## 2026-11-24 · T7 accepted (DONE_WITH_CONCERNS)

- Orchestrator re-ran `cd apps/desktop && bun test src` (987 pass, 0 fail) and `bunx tsc --noEmit` (clean). It checked that the `ReviewBoard.tsx` diff (13 lines) touches no attention-set identifier.
- `ReviewRuns.dom.test.tsx` moved to `src/reviews/ReviewPanel.dom.test.tsx`; only the 8 tab-click lines were dropped. The Review rules tests moved to `ReviewsView.dom.test.tsx`.
- Concerns: tests were not written red-first (the worker reported 8 mutations, each caught); `ReviewBoard.dom.test.tsx` will conflict with PR #1300; `ReviewDetail` still accepts the unused `onOpenReviewSession`; the toolbar is not re-measured (T11); the app makes one extra `review reviews` read at start; the spec's publication/author/Flow/period filters are not implemented (the plan narrows them to state/freshness/source plus search).
- Operator questions raised for the worker's behaviour choices; answers below.

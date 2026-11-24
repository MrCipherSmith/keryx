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

## 2026-11-24 · Operator answers on T7 choices

The operator answered in this session (AskUserQuestion), and every answer matches what T7 built:
- PR panel button for a PR without a Review keeps the existing launch labels.
- A Review hidden by filters, search or Show closed: the filters are cleared before it opens.
- Leaving the tab unmounts the panel and keeps the selection.
- The source label is 'Scheduled'.

Not asked, kept as implemented because each keeps the previous PR-panel behaviour: an answer intent opens the waiting question directly; a PR missing from the list gets one re-read, then a notice; the list refreshes when the open panel sees a run change.
- 2026-11-24T08:21:04.204Z - task-done: T7: Reviews tab: navigation, board/list/filters, Review panel with the moved review interface, indicator
- 2026-11-24T08:21:04.442Z - task-added: T14: Freshness kind unknown when the PR head is unknown (operator decision), CLI and Reviews tab
- 2026-11-24T08:21:04.796Z - task-attempt: T8: started (attempt 1) — 519-T8
- 2026-11-24T08:21:05.118Z - task-attempt: T14: started (attempt 1) — 519-T14
- 2026-11-24T08:23:45.674Z - task-done: T14: Freshness kind unknown when the PR head is unknown (operator decision), CLI and Reviews tab

## 2026-11-24 · T14 accepted, T8 accepted (DONE_WITH_CONCERNS)

- T14: the freshness kind `unknown` is added in the CLI and the Reviews tab. The label is lowercase 'head unknown', matching its neighbours 'current' and 'behind N'. Tests: 25/0 backend, 48/0 reviews DOM.
- T8: needsViewerAttention drops the local-review clauses, which closes deviation (b). The outdated action is labelled 'New review round'. F-024 (secondaryNote) is removed, and the outdated note now appears once, on its own line.
- AC9 mutation check, run by the worker: 13 one-line mutations of needsViewerAttention (model.ts lines 39-43), including re-adding each removed clause. Each one failed at least one test. The file was restored byte-identical (cmp).
- ReviewBoard.tsx: the only T8 edit is the `badgesEqual` line, which now also compares outdated.round. The orchestrator checked the diff; the attention-set code is unchanged.
- Title wording without a round ('Reviewed abc1234 — start a new round on the current head') was the worker's choice. The orchestrator accepted it as plain and accurate, without an operator question.
- The orchestrator re-ran apps/desktop `bun test src` (989 pass, 0 fail) and `tsc --noEmit` (clean).
- 2026-11-24T08:26:21.029Z - task-done: T8: Pull requests board: indicator without local review, New review round label, F-024

## 2026-11-24 · T11 Reviews toolbar measurement (orchestrator)

The Reviews toolbar was measured in the browser dev build (`bun run dev:browser`) with KERYX_DATA_DIR set to a scratch copy of the working DB. That kept the operator's real store from being migrated. The board was the keryx repo on real GitHub; the list was empty because every Review in the copy belongs to another repository. Viewport 1700x900; the section width was forced through the panel widths.
- First measurement: the row wrapped at 1180, 900, 820 and 760-560 px. The cause: the three filter selects had a fixed width under `flex: none`.
- Fix in review.css: the Reviews selects get `flex: 1 1 5rem; min-width: 5rem; max-width: 9.5rem`.
- After the fix: one row with nothing clipped at 760, 800, 820, 900, 1000, 1100, 1101, 1180 and 1380 px. Two rows at 700, 660, 620 and 560 px; three at 340 px. Nothing is clipped at any width.
- At 560 px the toolbar needs 648 px even with every item at its minimum. One row there would require hiding a control. This is recorded as a known limit in the implementation plan, in the spirit of stage 0 deviation (c).
- The PR toolbar was not re-measured: stage 2 only removed the Review rules button from it, which only shrinks it.
- The live check also covered: tab order and the ⌘3 label, the Reviews tab loading `review reviews` against real GitHub through the working-tree CLI, and the empty state 'No Keryx reviews yet'. A 'Choose a GitHub account' prompt was dismissed with Later; no settings were changed.

## 2026-11-24 · T13 docs

implementation-plan.md 0.1.4 adds a «Состояние этапа 2» section; deviation (b) and F-024 are marked closed and decision (d) is relabelled. specification.md 0.1.3 adds the freshness kind `unknown`. The orchestrator corrected two lines with facts from the live check and the toolbar numbers.

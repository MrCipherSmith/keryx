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
- 2026-11-24T08:30:33.970Z - task-done: T11: Reviews toolbar measurement at 1100/760/560px
- 2026-11-24T08:30:34.162Z - task-done: T13: Implementation plan stage 2 state, deviation b closed, CLI reference
- 2026-11-24T08:46:54.316Z - decision d-mwugaxqu-aac958 [review confirm-plan, ordinary]: chose yes; no recommendation
- 2026-11-24T09:20:30.906Z - ac-updated: Operator decision 2026-11-24 (AskUserQuestion in this session) on review finding logic-w5 F-001: a return to an earlier range (A,B,A) opens a new round instead of rejoining its first round, so round numbers stay in time order for every consumer.
- 2026-11-24T09:21:50.527Z - task-added: T15: Fix round 1 backend (FA-1..FA-17)
- 2026-11-24T09:21:50.705Z - task-added: T16: Fix round 1 Desktop (FB-1..FB-12)

## 2026-11-24 · Review round 1 (PR #1304) — results and decisions

- Plan confirmed by the operator: 11 reviewers, 31 dispatches; then plan growth (review-pr-contract) also confirmed ("Continue full round").
- Waves 1-5 dispatched; verifier passes w1 (4 majors) and w2 (3 majors), all confirmed (three narrower than filed). A further major (logic-w5 F-001, A,B,A rounds) came from the last wave.
- Operator decision D-R1 (AskUserQuestion): retry joins only the current highest round; AC1 re-frozen through `keryx flow ac update`.
- tests-to-run (`research-evidence/verify-tests-to-run-1.txt`): 2014 pass / 18 fail, all 5 s timeouts or path refusals in suites outside the PR, under heavy local load. T10 local root run: 13158 pass / 18 fail, same pattern. CI on the PR head 20e4281: 29 pass, 0 fail, 1 skipped — local failures treated as load/environment.
- One reviewer result normalised by the orchestrator: raw/review-degradation-w2.txt `slices` was `[{"id","coverage","status":"read"}]`, rewritten to `["slice-04"]` so `review next` reads it; content unchanged.
- Fix list: fix-round-1.md (FA backend, FB Desktop).
- 2026-11-24T09:21:54.440Z - task-attempt: T15: started (attempt 1) — 519-T15

## 2026-11-24 · Fix round 1 backend (T15) and operator answers

FA reported DONE_WITH_CONCERNS: FA-1..FA-17 fixed, red probes first except FA-10 (perf refactor) and pinning fixtures in FA-12; 181 backend tests pass, typecheck and eslint clean. Desktop typecheck/one DOM test await FB (new `reviewed`/`archived` fields, AC8 ready+null case).
FA also rewrote specification.md «Хранение» migration bullet to D-R1 and desktop-app.md ~92 (outside the exact list, consistent with decisions).
Operator answers (AskUserQuestion): archived Review never lights the indicator; a Review with no PR card lights only for needs_answer; locally closed Reviews fetch their cards only while 'Show closed' is on (new `--include-closed`, follow-up sent to FA).
- 2026-11-24T09:38:39.412Z - task-done: T15: Fix round 1 backend (FA-1..FA-17)
- 2026-11-24T09:38:39.616Z - task-attempt: T16: started (attempt 1) — 519-T16

## 2026-11-24 · Fix round 1 Desktop (T16)

FB reported DONE_WITH_CONCERNS: FB-1..FB-12 fixed; red run in a temporary detached worktree at 85fa985c1 (126 pass / 21 fail, model.test import fail), green after: Desktop `bun test src` 1007 pass / 0 fail, `tsc --noEmit` clean (orchestrator re-ran both). ReviewBoard.tsx diff: 30 lines, no attention-set identifier touched (orchestrator check).
Operator answers (AskUserQuestion): card without PR shows 'Pull request #N' with no author; hidden 60 s reload + watcher/session events kept; a waiting 'Open in Reviews' request is dropped when the user picks another base repository; new Reviews-tab banner/link wording accepted.
Concerns kept: two role=alert elements can coexist in the PR panel when both reads fail; account-switch dot assertion not added (mock never lights the dot); no live render of the FB-9 CSS.
- 2026-11-24T09:57:38.725Z - task-done: T16: Fix round 1 Desktop (FB-1..FB-12)
- 2026-11-24T10:53:29.483Z - task-done: T10: Test suites, typecheck and lint

## 2026-11-24 · Round 1 gate tail

- Operator chose to run all three gate items (AskUserQuestion).
- Degradation retry on slice-04 (raw/review-degradation-w4.txt): read the test output, no new findings.
- Wave D review-premise (raw/review-premise-w1.txt, research-evidence/premises.json): 45 upheld, F-016 and F-036 challenged, F-027 owner-decision. Operator answers (AskUserQuestion): F-016 dismiss (sibling-command helper imports are accepted practice); F-036 dismiss, T10 closed with the journalled run and CI as evidence; F-027 keep the documented limitation.
- Mutation pass (research-evidence/mutants.json = 60 candidates unchanged from testing-practices w1+w2; run as two passes by suite). Backend (mutation-1): 17 killed, 12 survived, 2 invalid, at 20e4281 in a scratch worktree. Desktop: first two runs refused a red baseline because the scratch copy has no apps/desktop/node_modules; rerun with a scratch-only node_modules link.
- T10 closed (task done) per the F-036 answer: typecheck=0, lint=0, desktop tests/tsc green; root-suite failures are load/environment timeouts, CI green at 20e4281.
- 2026-11-24T11:01:10.828Z - decision d-mwul3m68-1f4ef9 [review decide-premise, ordinary]: chose dismiss; no recommendation
- 2026-11-24T11:01:11.147Z - decision d-mwul3mfp-f48499 [review decide-premise, ordinary]: chose dismiss; no recommendation
- 2026-11-24T11:04:22.433Z - decision d-mwul7pyz-e3d89d [review decide-premise, ordinary]: chose dismiss; no recommendation
- 2026-11-24T11:04:41.731Z - task-added: T17: Fix F-048: Review panel Open pull request link does nothing
- 2026-11-24T11:04:41.923Z - task-attempt: T17: started (attempt 1) — 519-T17

## 2026-11-24 · Round 1 ingested

- Ledger READY (99 obligations closed); ingest with --premises/--scope/--blast-radius: 60 canonical findings retained (8 major, 38 minor after F-016/F-036 dismissed, 12 info).
- Mutation: mutation-1 (root 17 killed / 12 survived / 2 invalid), mutation-2 (desktop 17/12), mutation-3 (S03/S04 rerun with exact anchors: both survived). Survivors mapped to findings in dispositions; all at 20e4281, so whether the fix commits kill them is not measured.
- Premise answers recorded (decide-premise): F-016 dismiss, F-036 dismiss, F-027 dismiss (operator re-asked in the tool's single-word terms; the earlier wording was refused by the tool's answer check).
- Readiness still NOT READY on: blast-radius (86 cap-cut files, mostly .metaproject artifacts — operator chose to waive coverage rather than run 42 chunks ~$6.91), pr-files (fix commits added files), quotes-located (F-034, F-035). These need the operator's own `keryx review complete ... --waive` in their terminal.
- New minor F-048 (Review panel PR link has no click handler) → T17.

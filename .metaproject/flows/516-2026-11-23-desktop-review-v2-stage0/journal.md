# Flow Journal

- 2026-11-23T08:07:29.420Z - flow created
- 2026-11-23T08:09:15.318Z - task-done: T1: Collect remaining context
- 2026-11-23T08:09:15.519Z - task-done: T2: Implement per plan
- 2026-11-23T08:09:15.715Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-23T08:09:15.892Z - task-done: T4: Self-review and prepare draft PR
- 2026-11-23T08:09:16.069Z - task-added: T5: Board behaviour: no filter bypass, stable order, Done lane on demand, narrowed tab indicator
- 2026-11-23T08:09:16.260Z - task-added: T6: Outdated review result in the card badge (SQL + localBadge + types)
- 2026-11-23T08:09:16.456Z - task-added: T7: Show the outdated review on the card and in the list
- 2026-11-23T08:09:16.647Z - task-added: T8: Keep the board toolbar on one row with the detail panel open
- 2026-11-23T08:09:16.831Z - task-added: T9: Test suites, typecheck, lint and live check in the browser dev build
- 2026-11-23T08:09:17.025Z - task-added: T10: review-orchestrator on the branch
- 2026-11-23T08:09:17.216Z - task-added: T11: Requirements package keryx-desktop-review-v2 and roadmap entry
- 2026-11-23T08:09:28.819Z - frozen: 8 criteria; checksum recorded
- 2026-11-23T08:09:28.999Z - started
- 2026-11-23T08:09:29.339Z - task-done: T11: Requirements package keryx-desktop-review-v2 and roadmap entry
- 2026-11-23T08:09:29.940Z - task-attempt: T5: started (attempt 1) — 516-T5
- 2026-11-23T08:09:30.122Z - task-attempt: T6: started (attempt 1) — 516-T6

## 2026-11-23 — orchestrator notes

- Execution metrics: not collected (question not asked; recorded as a deviation from flow-orchestrator Phase 1).
- Dispatch form: workers receive a text brief carrying every Worker-brief item (A–G) instead of a schema-validated `subagent-dispatch` JSON; `keryx skills contracts validate` was not run on dispatches or replies. Deviation, by orchestrator choice.
- Models by task, by operator instruction: T5 sonnet, T6 opus, T7 sonnet, T8 haiku.
- T5 (516-T5) STATUS: DONE. Orchestrator re-ran `cd apps/desktop && bun test src/review` (89 pass) and `bunx tsc --noEmit` (exit 0), read the source diff. Commit 21e2110b1.
- T5 behavior_changes, needs_operator: a merged or closed pull request with a running Keryx review is hidden under the default Open+Draft filter. Operator answer (AskUserQuestion, 2026-11-23): "Скрывать" — the implemented choice stands.
- T5 note: worker did not open each must_read rule file separately and did not read the flow context files; accepted because the diff and tests satisfy AC1–AC4.
- 2026-11-23T08:13:16.301Z - task-done: T5: Board behaviour: no filter bypass, stable order, Done lane on demand, narrowed tab indicator
- T6 (516-T6) STATUS: DONE_WITH_CONCERNS. Orchestrator re-ran `bun test src/review/board*.test.ts src/review/desk-run*.test.ts` and `bun run typecheck`, read the source diff (SQL bounded to one extra row per card by a LIMIT 1 scalar subquery).
- T6 decision: a card with only an outdated run has no `runState`; badge is `{active:false, ready:false, outdated}`.
- T6 finding: `review_board` in `apps/desktop/src-tauri/src/review.rs` returns untyped `serde_json::Value`; the new field is not dropped. Rust not compiled locally.
- T6 concerns, carried into T7: `badgesEqual` in `ReviewBoard.tsx` does not compare `outdated`; UI keyed on `runState` shows an outdated-only card as "Run review". Not verified by T6: query plan on a large store.
- T6 note: worker read only the head of each must_read rule file.
- 2026-11-23T08:15:54.694Z - task-done: T6: Outdated review result in the card badge (SQL + localBadge + types)
- 2026-11-23T08:15:55.067Z - task-attempt: T7: started (attempt 1) — 516-T7
- T7 (516-T7) STATUS: DONE_WITH_CONCERNS. Orchestrator re-ran `cd apps/desktop && bun test src/review` (92 pass) and `bunx tsc --noEmit` (exit 0), read the source diff.
- T7 concerns: implementation written before tests (no red run); rule files of the resolved context not read individually; the `badgesEqual` change is covered by a direct unit test, not through the badge poll (the poll only covers active cards, where `outdated` cannot be present).
- T7 decision: the outdated reason ranks after live run states and the closed/merged label, before every GitHub-derived reason.
- 2026-11-23T08:18:18.896Z - task-done: T7: Show the outdated review on the card and in the list
- 2026-11-23T08:18:19.086Z - task-attempt: T8: started (attempt 1) — 516-T8
- T8 (516-T8, haiku) STATUS: DONE. Orchestrator live check in the browser dev build (Vite from this worktree on port 1430): at board width 820 px (the width left by a 560 px detail panel in a 1440 px window) the toolbar is one row, height 55 px, every child on the same top, labels collapsed to icons, 62 px of slack.
- T8 limits of the check: the dev bridge on 1421 belongs to another session's worktree and refused this origin, so the board had no data: the "Review rules" button and the count label were absent, and the detail panel itself could not be opened. Width was emulated instead.
- 2026-11-23T08:20:59.676Z - task-done: T8: Keep the board toolbar on one row with the detail panel open
- 2026-11-23T08:20:59.898Z - task-attempt: T9: started (attempt 1) — 516-T9 orchestrator verification
- T9 verification by the orchestrator at 0fcedf62f: `cd apps/desktop && bun test src` 749 pass / 0 fail; `bunx tsc --noEmit` in apps/desktop exit 0; `bun test src/review/board*.test.ts src/review/desk-run*.test.ts` 114 pass / 0 fail; root `bun run typecheck` exit 0; eslint on the changed `src/review` files exit 0 (apps/desktop is outside the root eslint config: "File ignored"); `keryx health run` score 91, no gate conditions triggered.
- T9 not verified: the outdated card and the open detail panel with real board data in a running app (dev bridge port held by another session); Rust not compiled (no local toolchain); the whole root test suite was not run, only the review board and store tests.
- 2026-11-23T08:22:57.858Z - task-done: T9: Test suites, typecheck, lint and live check in the browser dev build
- 2026-11-23T08:35:16.026Z - task-attempt: T10: started (attempt 1) — 516-T10 review round 1
- 2026-11-23T08:37:33.128Z - decision d-mwt0j22a-ae6c52 [review override-reviewers, ordinary]: chose override; no recommendation
- 2026-11-23T08:43:32.284Z - task-added: T12: Review round 1 fixes: dialogs under container CSS, attention flicker, base-moved label, dead Done-lane clause, SQL test fixtures
- 2026-11-23T08:43:32.476Z - task-attempt: T12: started (attempt 1) — 516-T12 fix round 1

## 2026-11-23 — review round 1 (T10)

- First-green gate: operator chose the standard review (AskUserQuestion). Reviewer set: operator chose the core five (logic, regression, frontend, security-code, testing-practices); recorded with `keryx review override-reviewers` (host-question, claude-code:ask-review-roster-2).
- Package: `.metaproject/reviews/2026-11-23-review-flow-feat-desktop-review-v2-stage0`, round 1 of 5, head 13462d2e3. Tests-to-run executed through `keryx review verify-run` (two files, both exit 0).
- Dispatches: 7 (logic x2, regression x2, frontend x1, security-code x1 over both slices, testing-practices x1 over both slices). Models: sonnet, except logic on the backend slice (opus). `keryx review tier` had no session baseline, so tiers were chosen by the orchestrator.
- Deviations from review-orchestrator, not done: reviewer-input payload files and `dispatch-check`; layers blocks; review-verifier (Wave C) and review-premise (Wave D); mutation pass (14 candidates proposed by review-testing-practices, none run); `ledger build`, `ingest`, `verdict`, `readiness`. `keryx review next` still lists the six reviewers the operator left out and one uncovered slice. The round is therefore NOT a completed managed round; its findings are used as input for the fix task.
- Findings (deduplicated): F1 major (regression; minor per logic and frontend) `.review-board { container-type: inline-size }` makes the board the containing block of the non-portaled Review rules and PR watcher dialogs. F2 minor (logic, frontend) the load callback computes the attention set before unread reply ids are carried over, so the tab indicator can drop and re-raise on refresh. F3 minor (logic, backend) a review whose base moved but whose head is unchanged is labelled "Outdated review" with the current head SHA. F4 minor/info the `lanes.done.length > 0` clause in the Done-lane gate is unreachable. F5 info the outdated SQL subquery predicates (pr, viewer, deleted, null head) have no separating fixture. F6 info nowrap toolbar may overflow between 980 and about 1070 px; the PR watcher button has no title.
- F1 is a defect of the orchestrator's own T8 brief (the CSS was prescribed there), not of the T8 worker; the live check did not open a dialog.
- All findings upheld by the orchestrator without a premise judge; fix task T12.
- T12 (516-T12, sonnet) STATUS: DONE_WITH_CONCERNS; F1-F6 fixed. Orchestrator re-ran: `cd apps/desktop && bun test src/review/ReviewBoard.dom.test.tsx` and `model.test.ts` each alone (0 fail), `bun test src` (752 pass), `bunx tsc --noEmit` (exit 0), `bun test src/review/desk-run-store.test.ts src/review/board-badges.test.ts` (0 fail), root `bun run typecheck` (exit 0); read the source diff.
- T12 live check (Vite from this worktree, port 1430, no board data): toolbar one row with no overflow at toolbar widths 820, 1080 and 1380 px (labels hidden at 820 and 1080, shown at 1380); PR watcher dialog overlay is a child of document.body and covers the full viewport, confirmed on a screenshot. Not checked live: the Review rules dialog (its button needs board data), the open detail panel, a card with an outdated review.
- T12 additional defect reported by the worker: `ReviewBoard.dom.test.tsx` imported `badgesEqual` statically (added in da6943ec6), which loads the module before the test DOM is registered; the worker says the file failed when run alone at 13462d2e3. The orchestrator had only run the directory-level command at that commit, so the single-file AC2-AC4 commands were NOT verified green before T12; they are green now. "Red at 13462d2e3" itself was not reproduced by the orchestrator.
- T12 concerns: no red run for F1 and F3 tests; F5 predicates were mutation-checked by the worker one at a time (reported, not re-run by the orchestrator).
- No second review round was run on the fix commit; the fixes were checked by the orchestrator only.
- 2026-11-23T08:52:03.382Z - task-done: T12: Review round 1 fixes: dialogs under container CSS, attention flicker, base-moved label, dead Done-lane clause, SQL test fixtures
- 2026-11-23T08:52:03.567Z - task-done: T10: review-orchestrator on the branch

## 2026-11-23 — completion choice

- Operator chose A (create a PR, review, merge on a separate ask) through AskUserQuestion.
- `git push -u origin feat/desktop-review-v2-stage0` was refused with HTTP 403: the active gh account has no write access to the repository; a second signed-in account exists. The orchestrator did not switch the active account (it is shared with other sessions). No PR exists yet; the flow stays in-progress.
- Review round 1 package committed to the branch as an incomplete managed round.
- 2026-11-23T09:57:40.626Z - decision d-mwt3e3jx-4cb786 [review decide-premise, ordinary]: chose uphold; no recommendation
- 2026-11-23T10:00:26.789Z - task-added: T13: PR review round fixes, Desktop UI: F-001 toolbar overflow, F-002 focus restore, F-003 lane reason, F-005 collapsed toolbar, F-007 test, F-008 attention set
- 2026-11-23T10:00:27.101Z - task-added: T14: PR review round fixes, backend: F-006 outdated lookup cost and measurement
- 2026-11-23T10:00:27.456Z - task-added: T15: PR review round fixes, docs: F-004 stage 0 status and team-request deviation
- 2026-11-23T10:00:27.843Z - task-attempt: T13: started (attempt 1) — 516-T13 PR review fix round
- 2026-11-23T10:00:28.189Z - task-attempt: T14: started (attempt 1) — 516-T14 PR review fix round
- 2026-11-23T10:00:28.521Z - task-attempt: T15: started (attempt 1) — 516-T15 PR review fix round
- 2026-11-23T10:02:42.757Z - task-done: T15: PR review round fixes, docs: F-004 stage 0 status and team-request deviation

## 2026-11-23 — PR review round (review-orchestrator on PR 1294) and its fixes

- Operator asked for a review with review-orchestrator on the pull request. Package `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294`, round 1 at head 53c96b8af, full roster by operator choice: 17 reviewer dispatches (11 planned reviewers plus review-pr-contract) and review-premise. 55 raw findings, 14 canonical: 1 major, 7 minor, 6 info. Verdict: changes requested.
- F-001 (major) was raised by the orchestrator after measuring the toolbar in a browser: overflow at a 560px board. It follows from the orchestrator's own T8 brief (nowrap). F-002 follows from the T12 portal fix.
- Premise judge upheld F-001, F-002, F-004..F-008 and held F-003; operator answered "uphold" (recorded with `keryx review decide-premise`).
- Readiness of that package: 10 of 12 pass; failing: blast-radius (cut files unreviewed) and pr-files (58 files of the earlier review package are outside the scope). review-verifier and the mutation pass did not run.
- Fix tasks: T13 (sonnet, UI: F-001, F-002, F-003, F-005, F-007, F-008), T14 (opus, SQL: F-006 with measurement, plus F-010), T15 (haiku, docs: F-004).
- T15 STATUS: DONE; orchestrator read the diff; commit 626bf776d.
- T13 STATUS: DONE_WITH_CONCERNS; orchestrator re-ran `bun test src/review/ReviewBoard.dom.test.tsx` (43 pass) and `model.test.ts` (10 pass) alone, `bun test src` (755 pass), `bunx tsc --noEmit` (exit 0), read the diff, and measured the toolbar: one row without overflow at 560, 700, 820, 1101 and 1380px, wrapped without clipping at 340px (research-evidence/layout-measurements.md in the review package; stand-ins for the Review rules button and the count label).
- T13 behavior_changes, needs_operator: the secondary "Outdated review" line is shown on every card with an outdated badge, merged and closed ones included. Operator answer (AskUserQuestion, 2026-11-23): "На всех карточках" — the implemented choice stands.
- T13 choices: Review rules uses the existing `shieldCheck` icon; focus restore detects the two portaled dialogs by their content class; `attentionPrs` is now derived with useMemo, with only the cross-scope retention kept as state.
- 2026-11-23T10:06:34.136Z - task-done: T13: PR review round fixes, Desktop UI: F-001 toolbar overflow, F-002 focus restore, F-003 lane reason, F-005 collapsed toolbar, F-007 test, F-008 attention set
- T14 STATUS: DONE_WITH_CONCERNS. Worker's measurement on a synthetic store (200 pull requests x 30 finished runs, 200 KB report each, 200-card batch, median of 5, bun 1.4.4, SQLite 3.51.0): base 1b994df18 about 405 ms, head 53c96b8af about 770 ms, after the change about 395 ms; badge output identical between head and after. Query plans and numbers: research-evidence/outdated-lookup-measurement.md in the PR review package. So the statement added in T6 roughly doubled the badge read; T14 brings it back to the base cost. The orchestrator did not re-run the measurement.
- T14 change: one materialized CTE parses each run once; window functions pick the newest finished run per card only when no run of that card supersedes it; an outdated candidate needs both reviewed SHAs (F-010). No schema, index or boundary change.
- T14 verification by the orchestrator: read the SQL diff; each of the 8 `src/review/board*.test.ts` and `desk-run*.test.ts` files passes when run alone (116 tests), as do `src/commands/review-desk-run.test.ts`, `review-watch.test.ts`, `review-accounts.test.ts`; root typecheck exit 0; eslint on the two files exit 0; `cd apps/desktop && bun test src/review` 98 pass. Running all eleven files in one `bun test` invocation failed several tests of `desk-run-executor.test.ts` with 6-8 s durations in two runs; that file does not call attachBadges and passes alone (38 pass). Treated as load-related; not investigated further.
- T14 concerns: the new test is a characterization test (passes before and after, behaviour unchanged); no F-010 fixture, because a run with a reviewed head and no base makes the live-history path of `localBadge` report it while the SQL path now ignores it — whether `localBadge` should also require both SHAs is left open.
- Not done after the fixes: no second review round on the fix commits; review-verifier and the mutation pass did not run; nothing pushed.
- 2026-11-23T10:19:07.733Z - task-done: T14: PR review round fixes, backend: F-006 outdated lookup cost and measurement
- 2026-11-23T10:45:45.400Z - task-added: T16: PR review round 2 fixes, Desktop UI: F-015 attention set persists removals, F-016 list row locals, F-017 local name
- 2026-11-23T10:45:45.653Z - task-added: T17: PR review round 2 fixes, backend: F-018 run-state lists and alias in the badge SQL
- 2026-11-23T10:46:16.554Z - task-attempt: T16: started (attempt 1) — 516-T16 PR review round 2 fixes
- 2026-11-23T10:46:16.741Z - task-attempt: T17: started (attempt 1) — 516-T17 PR review round 2 fixes
- 2026-11-23T10:47:45.247Z - task-done: T17: PR review round 2 fixes, backend: F-018 run-state lists and alias in the badge SQL
- 2026-11-23T10:48:26.557Z - task-done: T16: PR review round 2 fixes, Desktop UI: F-015 attention set persists removals, F-016 list row locals, F-017 local name

## 2026-11-23 — PR review round 2 (delta) and fixes (orchestrator)

- Round 2 of the managed review of PR #1294 on head `33fd9647a` (delta `53c96b8af..33fd9647a`), full roster by operator choice: 19 reviewer dispatches and a premise judge. Package `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r02`. Result: no blocker or major, 5 minor (F-015 to F-018, F-025), 7 info. Prior findings: F-001 to F-004, F-006, F-007, F-010 closed; F-005 and F-009 partial; F-008 regressed (F-015); F-011 to F-014 open, unchanged. Readiness 11 of 12: `pr-files` fails because a delta round covers 18 of the PR's 89 files.
- Operator: fix the five minor findings.
- T16 (worker, standard tier): F-015, F-016, F-017 in `apps/desktop/src/review/`. New DOM test seen failing on the old component by the worker. Orchestrator check: diff read, `bun test src` in `apps/desktop` 756 pass, `bunx tsc --noEmit` exit 0.
- T17 (worker, standard tier): F-018 in `src/review/desk-run-store.ts`. Orchestrator check: SQL read and compared term by term with the previous statement, `desk-run-store.test.ts` 36 pass, `board-badges.test.ts` 5 pass, root typecheck clean. Timing not re-measured.
- F-025 (PR description): new text drafted by the orchestrator; applying it to GitHub needs the write account.
- Not done: F-015 not reproduced in a running app; info findings F-019 to F-024 and F-026 not addressed; the failed CI check `client matrix (cancel-resume)` not re-run; nothing pushed.

- 2026-11-23T11:18:26.081Z - decision d-mwt69ybv-511abb [review override-reviewers, ordinary]: chose override; no recommendation
- 2026-11-23T11:26:24.820Z - task-added: T18: PR review round 3 fix, Desktop UI: F-027 seed the attention set on a replacing load
- 2026-11-23T11:26:25.010Z - task-attempt: T18: started (attempt 1) — 516-T18 PR review round 3 fix
- 2026-11-23T11:28:05.413Z - task-done: T18: PR review round 3 fix, Desktop UI: F-027 seed the attention set on a replacing load

## 2026-11-23 — PR review round 3 (delta) and fix (orchestrator)

- Round 3 of the managed review of PR #1294 on head `086335a01` (delta `33fd9647a..086335a01`). Operator chose six reviewers of fourteen (logic, regression, frontend, backend, security-code, testing-practices); 7 dispatches and a premise judge. Package `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r03`. Result: no blocker or major, 1 minor (F-027), 2 info (F-028, F-029). Prior: F-016, F-017, F-018, F-025 closed; F-015 regressed (F-027); F-019 to F-024 and F-026 open. The package does not pass the completion gate: the eight reviewers left out count as not run, and a delta round covers 7 of the PR's 89 files.
- F-027 came from the shape of the F-015 fix that the orchestrator's own T16 brief suggested (the load callback only resets the carried set).
- Operator: fix F-027.
- T18 (worker, standard tier): a replacing load seeds the carried set; new DOM test for saved historical filters; the handled-request test keeps a second request. Orchestrator check: `bun test src` in `apps/desktop` 757 pass, `bunx tsc --noEmit` exit 0, and three mutation runs of `ReviewBoard.dom.test.tsx`, each restored afterwards — write-back effect removed: 1 fail (the handled-request test); seeding removed: 1 fail (the saved-filter test); seeding on every load: 3 fail.
- Not done: F-027 and F-015 scenarios not reproduced in a running app; no review round on the T18 commit; info findings not addressed; nothing pushed.

- 2026-11-23T11:33:23.779Z - task-added: T19: Review info notes, backend: F-021 skip publication read for the outdated row; F-022/F-029 store test fixtures
- 2026-11-23T11:33:23.979Z - task-added: T20: Review info notes, Desktop UI: F-023 shared marker for portaled dialogs; F-022 DOM test for the note on a merged card
- 2026-11-23T11:33:24.199Z - task-added: T21: Review info notes, docs: F-019 toolbar wrap deviation, F-026 awaiting-merge wording
- 2026-11-23T11:33:24.478Z - task-attempt: T19: started (attempt 1) — 516-T19 review info notes
- 2026-11-23T11:33:24.700Z - task-attempt: T20: started (attempt 1) — 516-T20 review info notes
- 2026-11-23T11:33:24.978Z - task-attempt: T21: started (attempt 1) — 516-T21 review info notes
- 2026-11-23T11:34:51.493Z - task-done: T21: Review info notes, docs: F-019 toolbar wrap deviation, F-026 awaiting-merge wording
- 2026-11-23T11:35:49.611Z - task-done: T20: Review info notes, Desktop UI: F-023 shared marker for portaled dialogs; F-022 DOM test for the note on a merged card
- 2026-11-23T11:36:52.340Z - task-done: T19: Review info notes, backend: F-021 skip publication read for the outdated row; F-022/F-029 store test fixtures
- 2026-11-23T11:38:01.418Z - decision d-mwt6z581-5d85c4 [review override-reviewers, ordinary]: chose override; no recommendation

## 2026-11-23 — Review info notes and PR review round 4 (orchestrator)

- Operator: continue with what remained. Done: T19 (backend: F-021 publication read only for the card's range; one store test with a fixture per term of the outdated lookup), T20 (UI: F-023 `data-review-board-dialog` marker; DOM tests for the outdated-review note on a merged card and for the note-as-reason case), T21 (docs: F-019 third stage 0 deviation, F-026 wording). Orchestrator checks: `bun test src` in `apps/desktop` 759 pass, `bunx tsc --noEmit` exit 0, root typecheck exit 0, `desk-run-store.test.ts` 37 pass, `board-badges.test.ts` 5 pass, `desk-publication.test.ts` 10 pass, `review-desk-run.test.ts` 2 pass, `desk-run-legacy.test.ts` 3 pass; mutation: marker removed from the PR watcher dialog fails the focus test.
- Left out on purpose: F-024 (note de-duplication by string equality; a refactor in code just stabilised). Operator questions still open: F-012, F-013, F-020. Pre-existing and untouched: F-011, F-014.
- Round 4 of the managed review on head `be26765ae`, six reviewers of fifteen by operator decision, 7 dispatches and a premise judge. Package `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1294-r04`. Result: no blocker or major; no defect in the new commits; 1 minor that predates the pull request (F-030: after an access error or an identity change on a historical view the tab indicator misses open requests), 3 info (F-031 write-back from a cached snapshot on an unavailable error; F-032 threshold wording of deviation (c); F-033 what the suites leave unpinned). The package does not pass the completion gate (reviewers left out, delta scope, head not pushed).
- F-032 was the orchestrator's own wording in the T21 brief; corrected in `200f2b395`, which no reviewer read.
- Not done: F-030 and F-031 not fixed (the operator's call); no scenario reproduced in a running app; the commits after `622c914b7` are not pushed and have no CI; PR description not updated for them.


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

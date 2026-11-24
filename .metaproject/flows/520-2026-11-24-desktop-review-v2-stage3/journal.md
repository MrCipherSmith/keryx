# Flow Journal

- 2026-11-24T07:28:08.299Z - flow created
- 2026-11-24T07:29:19.786Z - task-done: T1: Collect remaining context
- 2026-11-24T07:29:20.005Z - task-done: T2: Implement per plan
- 2026-11-24T07:29:20.287Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-24T07:29:20.486Z - task-done: T4: Self-review and prepare draft PR
- 2026-11-24T07:29:20.700Z - task-added: T5: D1: publish as is for the reviewed commit (server + dialog + tests)
- 2026-11-24T07:29:21.040Z - task-added: T6: D2: on_head_move type, defaults and parse (head-move.ts + tests)
- 2026-11-24T07:29:21.291Z - task-added: T7: Prior-attempt selection for update rounds (update-round.ts) + prior-round settings test
- 2026-11-24T07:29:21.529Z - task-added: T8: Item 3: Review again as update round of the same Review (blocked on stage 2 rounds)
- 2026-11-24T07:29:21.726Z - task-added: T9: Verify: backend + Desktop review suites, typecheck, lint, untouched-invariant diff
- 2026-11-24T07:29:21.953Z - task-added: T10: review-orchestrator round on the branch
- 2026-11-24T07:29:43.882Z - frozen: 9 criteria; checksum recorded
- 2026-11-24T07:29:44.073Z - started
- 2026-11-24T07:29:54.815Z - task-attempt: T5: started (attempt 1) — 520-T5
- 2026-11-24T07:29:54.994Z - task-attempt: T6: started (attempt 1) — 520-T6
- 2026-11-24T07:29:55.173Z - task-attempt: T7: started (attempt 1) — 520-T7
- 2026-11-24T07:32:02.125Z - task-done: T6: D2: on_head_move type, defaults and parse (head-move.ts + tests)

## 2026-11-24 T6 accepted (DONE_WITH_CONCERNS)

- `ask` + finished returns an `update` offer (spec "Перед публикацией": update is the primary action once a round finished). Accepted.
- Worker could not run eslint/tsc: worktree has no node_modules. Orchestrator runs them in T9 after `bun install`.
- Dispatch JSON files were not written or schema-validated; the dispatch carried the Worker brief fields in the prompt.

## 2026-11-24 T7 accepted (DONE)

- `selectPriorAttempt` skips attempts with a `delete`/`archive` decision (evidence withdrawn). Accepted.
- AC6 test passes on current code: the package candidate path never reads settings, so it is a regression guard, not red-first.
- Sensitivity evidence (worker): dropping `partial` acceptance and re-adding an options-key filter each failed a named test.
- The worker temporarily symlinked node_modules from another worktree to run tests, then removed it.
- 2026-11-24T07:35:54.838Z - task-done: T7: Prior-attempt selection for update rounds (update-round.ts) + prior-round settings test
- 2026-11-24T07:54:35.165Z - task-done: T5: D1: publish as is for the reviewed commit (server + dialog + tests)

## 2026-11-24 T5 accepted (DONE_WITH_CONCERNS)

- No new helper in desk-run-service.ts: `verifyDeskSubject` already takes a revision; publication passes the as-is variant's expected head. Deviation from plan A accepted.
- Sensitivity evidence (worker): each AC2 guard reverted and its test failed; the explicit digest entry for currentHead is a backstop (body already carries it).
- Rust `review_publish` passes request/state as `Value`; no Rust change.
- Desktop `.tsx` files are in the root ESLint ignore list and apps/desktop has no ESLint config: AC8's eslint over apps/desktop/src/review lints nothing there. Desktop tsc was run instead.
- behavior_changes flagged needs_operator, decided by the orchestrator as within D1 and listed in the PR for the owner:
  1. Save locally in the head-moved case stores the forced settings (comment, no inline). Accepted: this attempt can only ever be published as is now; an update round is a new attempt with its own draft.
  2. Dialog status wording "Reviewed commit <short>. The pull request has moved to <short> since. Publishing as is posts a Comment for the reviewed commit only." Accepted.
  3. "Update review to <sha>" placement (first footer button): no caller yet; revisit when item 3 wires it — spec calls it the primary action.
  4. General comment can be turned off in the head-moved case, which then refuses submit with the existing message. Accepted (no silent override).
- Orchestrator fixed T7's test typing (6 TS2379 under exactOptionalPropertyTypes) directly: mechanical test-only change, journaled here instead of a fix dispatch.
- 2026-11-24T08:16:57.645Z - task-added: T11: Fix round 1: review findings of round 1 on PR #1303
- 2026-11-24T08:16:58.249Z - task-attempt: T11: started (attempt 1) — 520-T11

## 2026-11-24 Review round 1 (PR #1303, head 9e871b17f)

- Package `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1303`, 11 reviewers (roster from `keryx review plan`), all DONE with results in `raw/`.
- Totals: blocker 0, major 1 (logic F-001: as-is offered after a force-push), minor 10, info ~12.
- tests-to-run: verify-tests-to-run-1 had 1 timeout + 1 follow-on error in `src/commands/review-desk-run.test.ts` under concurrent load; re-run alone (verify-tests-to-run-2) passed. Full backend `bun test src/review`: 5461 pass, 1 fail (`mutate.test.ts` SIGTERM test, passed alone) — both load flakes, files not touched by this PR.
- Fix round T11 dispatched for logic F-001, performance/degradation F-001, frontend F-001 = ui-ux UX-001, ui-ux UX-002, UX-003, testing F-001..F-003.
- Architecture F-001 (two prior-attempt rules) and F-002 (on_head_move default source), degradation F-002 (findingsKnown undefined): recorded as obligations of T8 in tasks.md; no code change now (wiring is item 3).
- Verifier (Wave C) and review-premise (Wave D) were not dispatched: the one major is fixed defensively in T11 regardless of whether GitHub returns 422, so its premise does not gate the fix. Recorded as Not run.
- 2026-11-24T08:26:00.635Z - task-done: T11: Fix round 1: review findings of round 1 on PR #1303
- 2026-11-24T08:28:08.753Z - ac-updated: AC7: ""Review again" on a card with an outdated review starts an update round of the same Review on the current head, with the previous round's findings attached. [verify: none — blocked on stage 2 rounds; criterion is rewritten with its test when item 3 is implemented]" -> "A new attempt on a newer head of the same Review (stage 2 round N+1, started by "Review again" / "New review round" or "Update review") builds on the previous round: after a partial previous round with accepted findings it runs in mode delta with a non-empty prior-findings list and the area the partial round did not cover planned as unreviewed; after a previous round run with different settings it still gets the previous findings; the previous-attempt rule exists once (selectPriorAttempt), the old options-key rule is gone. [verify: exec `bun test src/review/prior-round.test.ts src/review/update-round.test.ts src/review/desk-run-service.test.ts src/review/desk-run-executor.test.ts`]" (Stage 2 rounds landed (origin/feat/desktop-review-v2-stage2 98bec5904); item 3 is now implementable, so AC7 gets its real criterion and test command.)
- 2026-11-24T08:28:09.050Z - ac-updated: AC10: "(new)" -> "In the publish dialog with a moved head, "Update review to <sha>" starts a new round of the same Review on the current head; the keep/dismiss answers given in the previous round's draft are pre-selected in the new round's publication draft for findings with the same finding id. [verify: exec `sh -c 'bun test src/review/desk-publication.test.ts && cd apps/desktop && bun test src/reviews src/review'`]" (Spec 'Перед публикацией' and acceptance criterion 7: update action in the dialog and answers carried by finding id; implementable now that stage 2 rounds exist.)
- 2026-11-24T08:28:26.551Z - ac-updated: AC8: "Backend review tests, the Desktop review suite, typecheck and lint pass on the branch; the attention-set code, `attachBadges`/`localBadge` and the toolbar container queries are unchanged by this flow. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet origin/main -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts apps/desktop/src/styles/review.css'`]" -> "Backend review tests, the Desktop review suites, typecheck and lint pass on the branch; this flow leaves the attention-set code, attachBadges/localBadge and the toolbar container queries as stage 2 left them. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review src/reviews && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet 98bec59046d0ce30500b341e8c18ba5b767069bb -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts src/review/desk-run-store.ts apps/desktop/src/styles/review.css'`]" (Branch rebased onto stage 2 (98bec5904), which legitimately changes these files; the invariant now compares with the stage 2 tip, and covers the new src/reviews suite.)
- 2026-11-24T08:28:36.136Z - task-added: T12: Item 3 backend: update round builds on the previous round (prior selection, partial package, trust rule)
- 2026-11-24T08:28:36.364Z - task-added: T13: Item 3 Desktop: Update review action and finding answers carried by id
- 2026-11-24T08:28:37.754Z - task-attempt: T12: started (attempt 1) — 520-T12
- 2026-11-24T08:28:38.153Z - task-attempt: T13: started (attempt 1) — 520-T13
- 2026-11-24T08:38:11.386Z - task-done: T13: Item 3 Desktop: Update review action and finding answers carried by id

## 2026-11-24 Rebase onto stage 2; T13 accepted (DONE_WITH_CONCERNS)

- Rebased onto origin/feat/desktop-review-v2-stage2 @ 98bec5904 (stage 2 T5/T6/T7/T9/T14). Clean; one fix: stage 2 renamed ReviewRuns.dom.test.tsx to reviews/ReviewPanel.dom.test.tsx, dialog import path corrected. AC7 rewritten (item 3 real criterion), AC8 diff base moved to the stage 2 tip, AC10 added (Update review + answers by finding id).
- T13: Update review = start on the current range through the existing start path with the reviewed attempt's options; stage 2's roundFor makes it round N+1. Update is the primary button when offered; Publish as is becomes secondary (closes T5 decision 3). Answers seeded from the newest earlier attempt draft via previousRunId (<=8 hops, same-Review guard), answers only, own draft wins.
- needs_operator items decided by the orchestrator and listed in the PR for the owner: (1) Update starts directly with the previous options instead of opening the launch form; (2) the user stays in the Reviews panel; a board behind the push is refreshed; if the current head already has an attempt nothing new starts.
- 2026-11-24T08:46:48.935Z - task-done: T12: Item 3 backend: update round builds on the previous round (prior selection, partial package, trust rule)
- 2026-11-24T08:46:49.192Z - task-done: T8: Item 3: Review again as update round of the same Review (blocked on stage 2 rounds)

## 2026-11-24 T12 accepted (DONE_WITH_CONCERNS); T8 closed

- A partial Desktop package is a draft (status stays draft until `review complete` writes closed), with findings.json when ingested; completionOf gives eligible=false, completed=false.
- Trust design: new machine-local round-registry event `desk-partial`, written only by the executor when it hands a partial attempt's package from the user's own run store to the next round; prior-round admits a draft only with that vouch, and the finished-round vouch ignores desk-partial entries (a red test caught the hole where status is not part of the hashed identity). The spec's literal relaxation for every draft was rejected.
- Uncovered area: a vouched partial round stays completed=false, so weakReasons plan everything outside the delta as new code (whole prior range treated as uncovered; per-file partial coverage not reliable).
- Behaviour change: a retry on the same range no longer builds on another attempt of its own round (only earlier rounds count).
- Not verified: runDeskWorker end to end (needs GitHub); live Desktop update round.
- T8 open info-level follow-ups (not blocking): `findingsKnown: undefined` treated as unknown by selectPriorAttempt vs known elsewhere (degradation F-002); `reviews.on_head_move` column defaults to 'ask' for every Review incl. rule-created ones, while spec/D2 say rule runs default to follow — parseOnHeadMove/defaultOnHeadMove exist but nothing writes the default per source yet (architecture F-002).
- 2026-11-24T09:17:24.760Z - ac-updated: AC3: "The publish dialog with a moved head shows both commits, disables the verdict choice and inline comments, and labels the primary action "Publish as is for" the short reviewed commit; with the current head the dialog is unchanged. [verify: exec `sh -c 'cd apps/desktop && bun test src/review/ReviewRuns.dom.test.tsx'`]" -> "The publish dialog with a moved head shows both commits, disables the verdict choice and inline comments, and labels the as-is action "Publish as is for" the short reviewed commit; with the current head the dialog is unchanged. [verify: exec `sh -c 'cd apps/desktop && bun test src/reviews/ReviewPanel.dom.test.tsx'`]" (Stage 2 renamed ReviewRuns.dom.test.tsx to src/reviews/ReviewPanel.dom.test.tsx; the verify command follows the file (round 2 logic F-001). The as-is action is no longer always the primary one since T13 made Update review primary when offered.)
- 2026-11-24T09:24:30.152Z - task-added: T14: Fix round 2 backend: prior selection fallback, one prior rule for answers, registry lock and vouch API, compare cache, superseded as-is
- 2026-11-24T09:24:30.407Z - task-added: T15: Fix round 2 Desktop: Update busy/guard/autoPublish/Sessions, tests, docs
- 2026-11-24T09:24:31.665Z - task-attempt: T14: started (attempt 1) — 520-T14
- 2026-11-24T09:24:31.922Z - task-attempt: T15: started (attempt 1) — 520-T15
- 2026-11-24T09:32:22.490Z - task-done: T15: Fix round 2 Desktop: Update busy/guard/autoPublish/Sessions, tests, docs

## 2026-11-24 Review round 2 (PR #1303 head 412258583, range 98bec5904..head)

- Package `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1303-r02`, roster from `keryx review plan` (10) + review-pr-contract from `review next`; 2 slices (flow+Desktop / backend), 20 dispatches, all results in raw/.
- blast-radius refused to recount against the stacked base (100 files vs 32 recorded) — Not run; tests chosen with `keryx test related` and run through verify-run (-1, -2).
- harness-robustness "whole process group" test fails at stage 2 tip 98bec5904 and passes at main: inherited from stage 2, reported in the shared notes.
- Totals: blocker 0; major 2 (logic-w2 F-001 = architecture-w2 F-005 = degradation-w2 F-001: prior selection with no fallback; highload-w2 F-001 pre-existing registry compaction without lock); minors ~20 (deduplicated into T14 B1-B6 and T15 D1-D6 plus testing-w2 gaps forwarded to T14); infos ~15.
- AC3 test path corrected (stage 2 rename). PR body: automatic publication refuses a moved head before the compare/discussion reads (one PR read happens) — wording fixed (pr-contract PC-004).
- T15 accepted (DONE_WITH_CONCERNS): request() returns an outcome; Update disabled while busy; existing attempt on the target range shown instead of a second start; autoPublish not carried; Sessions offers no Update (explicit, tested); footer order Update, Publish as is, Close, Skip, Save. Toast texts decided by the orchestrator (listed in PR).
- 2026-11-24T09:51:12.372Z - task-done: T14: Fix round 2 backend: prior selection fallback, one prior rule for answers, registry lock and vouch API, compare cache, superseded as-is

## 2026-11-24 T14 accepted (DONE)

- B1 one ordering rule `priorAttemptCandidates` (newest round first, complete before partial); executor takes `previousRuns[]` and hands on the first qualifying (closed, or partial with recordPartialRound ok). B2 answers from `earlierRoundAttempts` (same Review, earlier rounds, not deleted/archived), newest draft wins. B3 registry append+compaction under withFileLock (lock failure → error → next candidate). B4 registryVouches ignores desk-partial internally. B5 definitive compare status cached per head. B6 superseded round refuses as-is ("Round N of this review is newer…").
- needs_operator (decided by orchestrator, listed in PR): B6 blocks on any newer round incl. a failed/running one.
- testing-w2 gaps 1-4 pinned (worker-level runDeskWorker still has only a source check; same-Review guard pinned without a killed mutant).
- Round 3 (verification of T14/T15) not run in this session: stopping point reported to the parent session.
- 2026-11-24T09:52:22.686Z - task-done: T9: Verify: backend + Desktop review suites, typecheck, lint, untouched-invariant diff
- 2026-11-24T10:03:38.822Z - ac-updated: AC8: "Backend review tests, the Desktop review suites, typecheck and lint pass on the branch; this flow leaves the attention-set code, attachBadges/localBadge and the toolbar container queries as stage 2 left them. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review src/reviews && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet 98bec59046d0ce30500b341e8c18ba5b767069bb -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts src/review/desk-run-store.ts apps/desktop/src/styles/review.css'`]" -> "Backend review tests, the Desktop review suites, typecheck and lint pass on the branch; this flow leaves the attention-set code, attachBadges/localBadge and the toolbar container queries as stage 2 left them. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review src/reviews && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet 20e4281a2ac0265ce0a54ebcd200cb3eb55cdc6b -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts src/review/desk-run-store.ts apps/desktop/src/styles/review.css'`]" (Branch rebased onto stage 2 tip 20e4281a2 (PR #1304), whose 4 new commits change ReviewBoard.tsx and review.css; the invariant compares with the base this branch actually sits on (round 3 logic F-001). Re-point again if stage 2 moves before merge.)
- 2026-11-24T10:08:11.280Z - task-added: T16: Fix round 3 backend: withdrawn newer round, superseded wording, package revision check, lock reclaim race, partial-candidate stall, lean history query
- 2026-11-24T10:08:11.476Z - task-added: T17: Fix round 3 Desktop: focus after Update, existing attempt on a behind board, toasts pinned, Update disabled while preview stale, docs
- 2026-11-24T10:08:12.238Z - task-attempt: T16: started (attempt 1) — 520-T16
- 2026-11-24T10:08:12.424Z - task-attempt: T17: started (attempt 1) — 520-T17
- 2026-11-24T10:15:03.924Z - task-done: T17: Fix round 3 Desktop: focus after Update, existing attempt on a behind board, toasts pinned, Update disabled while preview stale, docs
- 2026-11-24T10:28:16.255Z - ac-updated: AC8: "Backend review tests, the Desktop review suites, typecheck and lint pass on the branch; this flow leaves the attention-set code, attachBadges/localBadge and the toolbar container queries as stage 2 left them. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review src/reviews && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet 20e4281a2ac0265ce0a54ebcd200cb3eb55cdc6b -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts src/review/desk-run-store.ts apps/desktop/src/styles/review.css'`]" -> "Backend review tests (including the attachBadges/localBadge parity test in src/review/desk-run-store.test.ts), the Desktop review suites, typecheck and lint pass on the branch; this flow leaves the attention-set code, board-badges.ts and the toolbar container queries as stage 2 left them, and adds to desk-run-store.ts only a read-only query. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review src/reviews && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet 20e4281a2ac0265ce0a54ebcd200cb3eb55cdc6b -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts apps/desktop/src/styles/review.css'`]" (Round 3 performance F-001 fix (T16 B6) adds a read-only DeskRunStore.roundPlacements query; no attachBadges/localBadge line changes (verified by hunk listing), and the parity is guarded by its store test rather than a whole-file no-diff.)
- 2026-11-24T10:38:24.686Z - task-done: T16: Fix round 3 backend: withdrawn newer round, superseded wording, package revision check, lock reclaim race, partial-candidate stall, lean history query

## 2026-11-24 Rebase onto stage 2 tip 20e4281a2; review round 3; fix round T16/T17

- Stage 2 moved 4 commits (PR #1304, no force-push); rebased cleanly onto 20e4281a2 (no file overlap). AC8 diff base re-pointed to 20e4281a2 (round 3 logic F-001), then narrowed: T16 B6 adds a read-only `DeskRunStore.roundPlacements` query, no badge code touched, parity guarded by the store test.
- Round 3 package `...-pull-1303-r03`: 11 reviewers over 3 slices (24 dispatches). blocker 0; the two "major" items were process (AC8 base) and a test timing window (B3 race test), both fixed; ~15 minors, all fixed in T16 (backend) / T17 (Desktop) with red->green or killed mutants; infos recorded in raw/.
- Decisions (orchestrator): superseded messages per newer-round state (running / ready / no result); withdrawn newer rounds don't supersede; a behind board is refreshed when the head already has an attempt; Update review disabled while the preview is loading or stale, with a visible reason.
- Known limit: when the board was behind, the board refresh remounts the panel (stage 2's ReviewPanel keys on the head) and keyboard focus drops after Update review; fixing it needs stage 2's ReviewPanel.tsx.
- Found and fixed: an empty blast-radius.json left in the round 2 package by a refused recount broke `round-trip.test.ts` (every committed package must ingest).
- Full backend `bun test src/review` + file-lock: 5535/5536, the one failure being that artifact; round-trip green after removing it. Desktop 155/155; root and Desktop tsc and eslint clean.
- 2026-11-24T10:39:58.834Z - task-done: T10: review-orchestrator round on the branch
- 2026-11-24T11:15:32.837Z - task-added: T18: Fix CI: stale-lock reclaim deleted a fresh lock that reused the stale lock's inode (Linux); identity now dev+ino+mtime+still stale; new in-place rewrite test
- 2026-11-24T11:15:37.890Z - task-done: T18: Fix CI: stale-lock reclaim deleted a fresh lock that reused the stale lock's inode (Linux); identity now dev+ino+mtime+still stale; new in-place rewrite test

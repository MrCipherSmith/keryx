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

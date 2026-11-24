# Flow Journal

- 2026-11-24T07:28:14.584Z - flow created
- 2026-11-24T07:30:22.584Z - task-done: T1: Collect remaining context
- 2026-11-24T07:30:22.817Z - task-done: T2: Implement per plan
- 2026-11-24T07:30:23.058Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-24T07:30:23.286Z - task-done: T4: Self-review and prepare draft PR
- 2026-11-24T07:30:23.494Z - task-added: T5: Head moved procedure in review-orchestrator (both copies) + preflight test
- 2026-11-24T07:30:23.682Z - task-added: T6: Divergence map of session and Desktop publish paths with extraction plan
- 2026-11-24T07:30:23.909Z - task-added: T7: Shared publish code: review publish uses desk-publication acceptance, receipt, duplicate marker (needs stages 2+3)
- 2026-11-24T07:30:24.204Z - task-added: T8: Session and Desktop prompt use the same update command (needs stage 3)
- 2026-11-24T07:30:24.487Z - task-added: T9: Review round on the branch via review-orchestrator
- 2026-11-24T07:30:24.743Z - task-added: T10: Real-PR scenario: session review published from Desktop
- 2026-11-24T07:30:38.041Z - frozen: 7 criteria; checksum recorded
- 2026-11-24T07:30:38.356Z - started
- 2026-11-24T07:30:47.512Z - origin-set: unknown -> human-request; quote: "The user explicitly asked to start stage 4 now in its own worktree."; source: session local_4c9fedae-8b67-4970-82be-8662d726ed7d (Operator asked to start stage 4 now)
- 2026-11-24T07:31:02.926Z - task-attempt: T5: started (attempt 1) — 521-T5
- 2026-11-24T07:31:03.359Z - task-attempt: T6: started (attempt 1) — 521-T6

## 2026-11-24 T6 divergence map (DONE_WITH_CONCERNS)

- Map: `divergence-map.md`. Steps 1–5 of its plan work on the current run model, but step 1 (extracting a guard module from desk-publication.ts:240-254, 307, 341) overlaps lines stage 3 rewrites, so T7 waits for stage 3 to avoid a guaranteed conflict.
- Step 6 (cross-path duplicate test) needs stage 2 (session packages as Attempts with source `session`); step 7 needs stage 3.
- `githubPostReview` (`gh pr review`) returns no review id/URL; T7 must switch to `gh api .../reviews` or look up by marker after posting.
- Head semantics: the session path allows a moved head when report.md line 1 names the reviewed SHA (readiness item 7), Desktop refuses. D1 allows this only with COMMENT; T7 must add the COMMENT restriction to the session path rather than refusing outright.
- Not verified by the worker: completeHeadGate detail, review.rs after line 500, middle of ReviewPublishDialog.tsx; no tests run (read-only task).
- 2026-11-24T07:34:28.279Z - task-done: T6: Divergence map of session and Desktop publish paths with extraction plan

## 2026-11-24 T5 Head moved procedure (DONE_WITH_CONCERNS)

- `## Head moved` in SKILL.detail.md (both copies); SKILL.md step 5 and the publication tail point to it; SKILL.md stays at its 918-line ceiling. Preflight test: 83 pass (10 new).
- Worker added one line beyond the brief: the closed stop list in "Between waves" now names a moved head under `ask`; accepted, otherwise the `ask` question contradicts "The stop list is closed".
- "Stop and start on the new head" ingests a partial round; until stage 3 changes `round-record.ts:207`, the `keryx review plan` fallback may not treat a partial package as the prior round. The skill states the contract; T8 rechecks after stage 3.
- Environment: no node_modules in this worktree: eslint/tsc not run locally (health INCOMPLETE), clean-context/harness-robustness tests fail to load (zod). `bun test src/gdskills`: 8470 pass, 1 fail in install.test.ts (EACCES read-only rules/core), not in changed files, not confirmed on base. CI is the check.
- 2026-11-24T07:37:52.239Z - task-done: T5: Head moved procedure in review-orchestrator (both copies) + preflight test
- 2026-11-24T07:38:05.065Z - task-attempt: T7: blocked (attempt 1) — stage 2 (rounds model, flow 519) and stage 3 not pushed to origin on 2026-11-24; extraction overlaps lines stage 3 rewrites (divergence-map.md §5)
- 2026-11-24T07:38:05.306Z - task-attempt: T8: blocked (attempt 1) — keryx review advance comes with stage 3, not pushed on 2026-11-24
- 2026-11-24T07:38:05.650Z - task-attempt: T10: blocked (attempt 1) — needs T7 and T8

## 2026-11-24 Stages 2/3 check

- `git fetch origin`: no remote branch for stage 2 or stage 3. Local `feat/desktop-review-v2-stage2` has 3 commits (incl. 3f8c6ee9c "group desk review attempts into Reviews and rounds"), unpushed; stage 3 branch has 0 commits. Per the operator instruction T7, T8, T10 stay blocked; flow stays in-progress. Resume: rebase onto the stage 3 branch once it is pushed and sits on stage 2.
- 2026-11-24T07:54:50.153Z - task-added: T11: Fix round 1 findings of PR 1302 (R1-R14)
- 2026-11-24T07:54:50.353Z - task-attempt: T11: started (attempt 1) — 521-T11 fix round 1
- 2026-11-24T08:00:43.963Z - ac-updated: AC6: "The session procedure and the Desktop review prompt open the update round with the same command (`keryx review advance` or the name stage 3 gives it); `src/review/autonomous-profile.ts` no longer says "New commits belong to a separate request". [verify: invariant `! git grep -q "New commits belong to a separate request" -- src/review`]" -> "The session procedure and the Desktop review prompt open the update round with the same command (`keryx review advance` or the name stage 3 gives it); `src/review/autonomous-profile.ts` no longer says "New commits belong to a separate request", and its unattended head-move line (line 200 at a5d1ab236) agrees with the skill's "Head moved" unattended rule. [verify: invariant `! git grep -q "New commits belong to a separate request" -- src/review`]" (Review round 1 of PR 1302 (review-regression F-001) found autonomous-profile.ts:200 also governs head moves and was untracked)

## 2026-11-24 Review round 1 of PR 1302 and fix round T11

- Round 1 (package `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1302`): 9 reviewers, 34 raw items consolidated into 14 canonical (2 major, 9 minor, 3 info; R14 screened at ingest). Majors: R1 stop-and-start promised stage-3 prior-round rules; R2 unattended rule contradicted autonomous-profile.ts:200. Both confirmed by recorded code reads (research-evidence/verify-F-001-1.txt, verify-REG-F-001-1.txt). Not run: Wave C verifier, Wave D premise judge, mutation pass. Start questions took defaults (dispatched session).
- T11 fixed R1–R12 and R14 (R13 info, no action). 15 hand mutations of the new section each fail a non-parity test. Preflight + parity: 91 pass. bun test src/gdskills: 8471 pass, 1 known unrelated fail (install.test.ts EACCES).
- AC6 extended (keryx flow ac update) to include autonomous-profile.ts:200.
- 2026-11-24T08:00:55.107Z - task-done: T11: Fix round 1 findings of PR 1302 (R1-R14)
- 2026-11-24T08:11:24.588Z - task-added: T12: Fix round 2 findings of PR 1302 (S1-S9)
- 2026-11-24T08:11:24.813Z - task-attempt: T12: started (attempt 1) — 521-T12 fix round 2
- 2026-11-24T08:11:51.086Z - ac-updated: AC6: "The session procedure and the Desktop review prompt open the update round with the same command (`keryx review advance` or the name stage 3 gives it); `src/review/autonomous-profile.ts` no longer says "New commits belong to a separate request", and its unattended head-move line (line 200 at a5d1ab236) agrees with the skill's "Head moved" unattended rule. [verify: invariant `! git grep -q "New commits belong to a separate request" -- src/review`]" -> "The session procedure and the Desktop review prompt open the update round with the same command (`keryx review advance` or the name stage 3 gives it); `src/review/autonomous-profile.ts` no longer says "New commits belong to a separate request", and its unattended head-move line (line 200 at a5d1ab236) agrees with the skill's "Head moved" unattended rule (asserted by the preflight test). [verify: exec `bun test src/gdskills/review-orchestrator-preflight.test.ts && ! git grep -q "New commits belong to a separate request" -- src/review`]" (Round 2 of PR 1302 (S6): AC6's verify did not check its line-200 clause)

## 2026-11-24 Review round 2 and fix round T12

- Round 2 (package `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1302-r02`, delta, 10 reviewers / 20 drivers): R1, R2, R4–R12 closed; R3 partial. 9 canonical (0 blocker, 0 major, 4 minor, 5 info). S1: `git ls-remote`/`git fetch` are not in the trust/auto routine set (src/lib/trust-routine-command.ts:25-35), so the per-wave read still asks; the gate was left alone and the text now says so.
- T12 fixed S1–S3, S5, S7–S9 (skill text, the SKILL.md publication ending rewritten in place, test title, no keryx source paths in the bundled skill, absence assertions, cross-file test via buildAutonomousPrompt). S6: AC6 verify now also runs the preflight test. S4: PR body refreshed by the orchestrator. Tests: preflight + parity + autonomous-profile 108 pass; bun test src/gdskills 8472 pass, 1 known unrelated fail (install.test.ts EACCES). 10 hand mutations each fail a preflight test.
- Info noted, not acted on: committed review packages carry absolute local paths, as all 619 existing package files do (package-writer convention).
- 2026-11-24T08:16:03.283Z - task-done: T12: Fix round 2 findings of PR 1302 (S1-S9)

## 2026-11-24 Stage 3 pushed partially; review loop paused

- `origin/feat/desktop-review-v2-stage3` (9e871b17f, flow 520) is based on main, not on stage 2; it adds head-move.ts (on_head_move ask/follow/ignore, scheduled → follow), update-round selection, D1 publish-as-is in desk-publication.ts. No `keryx review advance` command, no rounds model. The rebase condition (stage 3 on stage 2 with rounds model and publish/update code) is not met: T7, T8, T10 stay blocked.
- Overlap for T7: stage 3 Desktop D1 first line is "Reviewed commit `<sha>`. The pull request has moved to `<new>` since; this review does not cover the newer commits." while the skill/template use "Reviewed `<sha>` — the PR has since moved on to `<new>`." Shared publish code must pick one form that also passes the `review complete` head gate.
- Review loop paused after round 2 (decision): a third round on bc24e74a6 would spend round 3 of the 5-round cap on minor text fixes, while T7/T8 add the publish/update code that needs the remaining rounds. T12 fixes are covered by tests and 10 hand mutations, not yet re-reviewed; the next round runs after the rebase.
- 2026-11-24T08:18:00.971Z - task-done: T9: Review round on the branch via review-orchestrator

## 2026-11-24 Rebased onto stage 3 (822192905); T7 session publish guard

- Rebased the 7 stage-4 commits from a5d1ab236 onto `origin/feat/desktop-review-v2-stage3` at 822192905 (stage 3 fix round 2 with T15, on stage 2 at 20e4281a2). No conflicts: stages 2 and 3 do not touch the skill or autonomous-profile.ts. Nothing pushed to or merged into the stage 2/3 branches.
- What stages 2–3 actually ship: no `keryx review advance` CLI (Desktop's "Update review" re-runs `keryx review desk-run start` on the new range of the same Review, ReviewWorkspace.tsx:133) and no `session` attempt source (DeskRun.source is still manual|scheduled|existing). Asked the parent session whether stage 4 builds `advance` and session-package registration (option A) or leaves them (option B).
- T7 part done (divergence-map rows 1–4, both options need it): `src/review/publication-guard.ts` holds the duplicate marker, the receipt (write-intent / confirm / drop on certain refusal) and the D1 first line. Desktop's `desk-publication.ts` now calls these helpers (5 insertions, 12 deletions, behaviour unchanged). `keryx review publish` and the shell card take the receipt, the marker and a lock; post through `gh api .../reviews` with `commit_id` = reviewed head (`src/review/session-publish-github.ts`); refuse a closed/merged PR; on a moved head allow only COMMENT and put the shared first line first unless the report already names the reviewed commit; re-read the head after the operator's yes. First-line decision: Desktop's line ("Reviewed commit `<sha>`. The pull request has moved to `<new>` since; …") is the one the code writes; it passes the `review complete` head gate (tested); a report's own gate-passing first line is kept.
- Not done in T7: the cross-path duplicate test of AC5 (needs session packages as Attempts, option A).

## 2026-11-24 Option A: session Attempts and keryx review advance (T7 rest, T8)

- The parent session relayed the user's choice of option A ("(A) Всё в этапе 4"): stage 4 builds `keryx review advance` over the stage 2/3 store, rewires Desktop's Update to it, registers session packages as `session` Attempts, and adds the cross-path AC5 test. Edits to desk-run-store.ts, review.rs and ReviewWorkspace.tsx kept additive and small (stage 3 round 3 touches the same area).
- Session Attempts (`src/review/session-attempt.ts`): `keryx review complete` and `keryx review publish` (and the shell card) register a PR-bound package with full base/head and a report as an Attempt with source `session`, id derived from account, repository, PR, review id and round; the Attempt holds a copy of the package (Desktop's reader refuses links), refreshed in place so Desktop's draft/receipt stay; a package inside the store (a Desktop worker's own) is never registered. Store: additive `recordSession` (only refreshes an undecided `session` row). `DeskRun.source`/`ReviewSource` gain `session`; Desktop's source label "Session".
- Shared receipt across paths: a registered package publishes with the Attempt directory's receipt and lock and the Attempt id as marker, the same ones `desk-publish` uses; the package's own earlier receipt is still read. AC5 tests: session publish then Desktop preview → "already been published"; Desktop submit then session publish → refused; re-registration keeps Desktop's files.
- `keryx review advance --json --repo --number [--id] [--repository-id --viewer] [--base --head]` (`src/review/review-advance.ts`, `src/commands/review-advance.ts`): updates from the Review's latest round (or `--id`), refuses a superseded round, a round on the current head, a closed PR and a changed account/repository/range, keeps the reviewed attempt's settings without autoPublish, and starts through `requestDeskRun` start. Desktop: action `advance` (reviewRuns.ts), Tauri `RunAction::Advance` → `review advance` args (review.rs, Rust test added; Rust verified in CI only), ReviewWorkspace's Update sends it; Desktop's `updateRoundOptions` moved to the backend. Desktop tests updated (174 pass).
- T8 text: skill "Head moved" steps 3–5 describe advance as the command both surfaces run, with `keryx review plan --head` to run the round in-session; autonomous-profile.ts fixed-range line drops "New commits belong to a separate request" and names `keryx review advance` outside the run, still "Keep this range" (skill maps it to `ignore`). Preflight test pins both.
- 2026-11-24T10:50:30.559Z - task-done: T7: Shared publish code: review publish uses desk-publication acceptance, receipt, duplicate marker (needs stages 2+3)
- 2026-11-24T10:50:30.749Z - task-done: T8: Session and Desktop prompt use the same update command (needs stage 3)
- 2026-11-24T11:44:33.384Z - task-added: T13: Fix round 3 findings of PR 1302 (T1-T16)
- 2026-11-24T11:44:33.648Z - task-attempt: T13: started (attempt 1) — 521-T13 fix round 3

## 2026-11-24 Review round 3 (T7/T8 code) and fix round T13

- Rebased onto stage 3 at 7a846bef1 (conflicts only in ReviewWorkspace.tsx and ReviewPanel.dom.test.tsx; resolved). Round 3 planned with `keryx review plan --ref 7a846bef1` (fallback-first: round 2's head is not an ancestor after the rebase), 3 slices, 10 reviewers, 26 driver waves; dispatched as 9 subagents (ui-ux and layout shared one). Package `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1302-r03`.
- 44 raw findings → 16 canonical (5 major, 11 minor), all acted on in T13; 13 others dispositioned (refuted / out-of-scope / narrowed) in `dispositions-3.json`. Majors: T1 a branch-name base (`origin/main`, 11 of 15 local PR packages) silently skipped registration; T2/T3 receipts and locks could split between the package and the Attempt, allowing a second post; T4 session publish lacked Desktop's superseded-round and ancestry checks; T5 Desktop treated `session` Attempts as worker runs (coordinator, Continue).
- Not closed: the ledger gate refuses completion because review-frontend and review-security-code ended PARTIAL (test and doc tails skimmed) and no reviewer model was recorded; no retry wave was spent. The mutation pass (testing reviewer: 29 mutants, 13 survived before T13) was not re-run after the fixes.
- Out of scope, recorded: the session path posts with the ambient `gh` account while the Attempt is keyed by the project-bound one; registration still recomputes readiness (a few extra gh calls).
- CI: "Core tests (2/4)" fails `src/lib/file-lock.reclaim.test.ts` on stage 3's head too (stage 3 commit 41779d177); left to stage 3.
- 2026-11-24T11:45:15.144Z - task-done: T13: Fix round 3 findings of PR 1302 (T1-T16)
- 2026-11-24T12:20:32.636Z - task-added: T14: Fix round 4 findings of PR 1302 (U1-U10)
- 2026-11-24T12:20:33.001Z - task-attempt: T14: started (attempt 1) — 521-T14 fix round 4

## 2026-11-24 Review round 4 (delta over T13) and fix round T14

- Rebased onto stage 3 at 373976c9d (stage 3's file-lock CI fix; clean). Main conflicts on PR 1302 are stage 3's (same 11 files as PR 1303); the parent session coordinates the rebase order stage 2 → 3 → 4.
- Round 4 planned with `--ref 98f777283` (round 3's head after the rebase): 2 slices, 10 reviewers, 12 dispatches in 5 subagents. Package `…-pull-1302-r04`. 42 raw findings → 10 canonical (1 major: the T3 lock order was untested; 9 minor), all acted on in T14; 32 others dispositioned in `dispositions-4.json`. Round-3 findings verified closed except T1/T4/T15 partial, which U2–U7 address; the base check at publish time stays a known gap.
- Ledger READY (completion gate satisfied); the package was not ingested or completed. Mutation pass (testing reviewer): 31 mutants, 18 killed, 13 survived before T14; T14 adds the lock-order, unknown-receipt, ancestry tri-state, current-head later-round, retarget-base and Desktop moved-range tests.
- 2026-11-24T12:20:33.826Z - task-done: T14: Fix round 4 findings of PR 1302 (U1-U10)

## 2026-11-24 Final rebase onto main and scoped review

- Stage 2 (#1304) and stage 3 (#1303, cd573dc07) are on main. Rebased once: `git rebase --onto origin/main 373976c9d` (13 commits, no conflicts). The only fix needed was a test assertion for stage 3's final banner wording ("Refresh to load the latest range."), which also made a negative assertion vacuous until corrected.
- Related suites only (owner rule: no full run, no mutation): root 375 pass, Desktop reviews/review/platform 288 pass, type-check clean in both packages.
- One review round scoped to the 7 files stage 3's final code changed under stage 4's edits (review.rs, ReviewRuns, ReviewWorkspace, reviews/model.ts, ReviewPanel test, desk-run-store.ts, review-entity.ts): no blockers or majors. Checked: session Attempt placement by the final assignReviews/roundFor, advance against the final newerRoundOf, a session Attempt as the base of a Desktop update round, the Reviews list labels and filters, hasDeskWorker gating.
- Deferred (owner rule: only blockers and majors are fixed from here): the minors and infos of rounds 1–4 dispositioned in each package's dispositions file, plus the open test gaps (review_complete card registration, card execute wiring, Desktop workspace/dialog gating, payloads/ copy filter, non-URL post fallback), publish-time base comparison, posting under the project-bound gh account, registration recomputing readiness, laterRoundOf reading the UI history snapshot.
- T10 (real-PR scenario) stays unverified.
- 2026-11-24T19:30:34.706Z - ac-updated: AC8: "(new)" -> "A diverged PR scopes the merge base to its pinned head, preserves the hosting base identity and retains incremental rounds. [verify: judged]" (Operator extended flow 521 to cover PR 9264 review behavior.)
- 2026-11-24T19:30:35.076Z - task-added: T15: Use the real PR diff for scope, slices and reviewer inputs
- 2026-11-24T19:30:35.818Z - task-attempt: T15: started (attempt 1) — Use the real PR diff for scope, slices and reviewer inputs
- 2026-11-24T19:30:36.219Z - ac-updated: AC9: "(new)" -> "Both entry points associate one review attempt with the actual project session and restore it from the board. [verify: judged]" (Operator extended flow 521 to cover PR 9264 review behavior.)
- 2026-11-24T19:30:36.619Z - task-added: T16: Open the originating interactive review session from the board and register chat reviews on launch
- 2026-11-24T19:30:37.332Z - task-attempt: T16: started (attempt 1) — Open the originating interactive review session from the board and register chat reviews on launch
- 2026-11-24T19:30:37.709Z - ac-updated: AC10: "(new)" -> "The active review shows the PR, changed file count, file/check rationale and current work in the review UI. [verify: judged]" (Operator extended flow 521 to cover PR 9264 review behavior.)
- 2026-11-24T19:30:38.091Z - task-added: T17: Explain review scope, selected checks and current stage in Desktop
- 2026-11-24T19:30:38.793Z - task-attempt: T17: started (attempt 1) — Explain review scope, selected checks and current stage in Desktop
- 2026-11-24T19:30:39.180Z - ac-updated: AC11: "(new)" -> "An exact plan needs at most one approval and a finished single-reviewer run exits without full-review nudges. [verify: judged]" (Operator extended flow 521 to cover PR 9264 review behavior.)
- 2026-11-24T19:30:39.564Z - task-added: T18: Suspend repeat prompts while awaiting review approval or after single-review ingestion
- 2026-11-24T19:30:40.277Z - task-attempt: T18: started (attempt 1) — Suspend repeat prompts while awaiting review approval or after single-review ingestion
- 2026-11-24T19:30:40.704Z - ac-updated: AC12: "(new)" -> "Both launches are verified against PR 9264 with publication disabled, with evidence of scope and session identity. [verify: judged]" (Operator extended flow 521 to cover PR 9264 review behavior.)
- 2026-11-24T19:30:41.101Z - task-added: T19: Exercise both Desktop entry points on PR 9264 and review the changes
- 2026-11-24T19:35:10.074Z - task-done: T15: Use the real PR diff for scope, slices and reviewer inputs
- 2026-11-24T19:35:15.323Z - task-done: T18: Suspend repeat prompts while awaiting review approval or after single-review ingestion
- 2026-11-24T19:41:52.008Z - task-attempt: T19: started (attempt 1) — Live scope checked against GitHub and actual Desktop launch from original chat. Verifying board return and card initiation.
- 2026-11-24T20:00:29.571Z - task-done: T16: Open the originating interactive review session from the board and register chat reviews on launch
- 2026-11-24T20:00:29.964Z - task-done: T17: Explain review scope, selected checks and current stage in Desktop
- 2026-11-24T20:00:30.348Z - task-done: T19: Exercise both Desktop entry points on PR 9264 and review the changes
- 2026-11-24T20:01:56.007Z - ac-confirmed: AC8: PR 9264 merge-base and two refs confirmed independently with Git and GitHub. (signed: local automated verification [stated])
- 2026-11-24T20:01:56.405Z - ac-confirmed: AC9: Both attempted reviews restored their original session from the card. (signed: local automated verification [stated])
- 2026-11-24T20:01:56.808Z - ac-confirmed: AC10: Native bundle renders 3 files, +169/-2, 15 selected checks and Review finished. (signed: local automated verification [stated])
- 2026-11-24T20:01:57.206Z - ac-confirmed: AC11: Two live runs with zero operator questions. Approval pause and single-reviewer terminal logic regression-tested. (signed: local automated verification [stated])
- 2026-11-24T20:01:57.615Z - ac-confirmed: AC12: Both actual entry points on PR 9264 verified locally; run IDs in review-session-verification.md. (signed: local automated verification [stated])
- 2026-11-24T20:03:00.875Z - task-added: T20: Increase large-review limits and approve affordable plan expansion automatically
- 2026-11-24T20:03:01.227Z - task-added: T21: Select and explain the effective model tier for each review assignment
- 2026-11-24T20:03:01.572Z - task-added: T22: Verify large-plan policy and tier assignments on PR 9264
- 2026-11-24T20:03:13.857Z - task-attempt: T20: started (attempt 1) — Inspect both standalone and Desktop plan confirmation and expansion paths.
- 2026-11-24T20:03:14.225Z - task-attempt: T21: started (attempt 1) — Trace policy through concrete provider/model assignment and render selection.
- 2026-11-24T20:03:14.573Z - task-attempt: T22: started (attempt 1) — Verify live PR plan and a large diff with an unchanged and a changed head.
- 2026-11-24T20:04:11.992Z - ac-updated: AC13: "(new)" -> "Large reviews use higher defaults and a recorded automatic expansion decision within the configured policy. Explicit budgets, changed revisions and manual confirmation are respected. [verify: judged]" (User extended the existing review scope to large PRs and automatic expansion.)
- 2026-11-24T20:04:12.340Z - ac-updated: AC14: "(new)" -> "Each assignment resolves its model tier from the reviewer and its actual scope, honors overrides, and exposes the chosen route and reason. [verify: judged]" (User requested improved three-tier routing per reviewer.)
- 2026-11-24T20:20:39.123Z - task-done: T21: Select and explain the effective model tier for each review assignment
- 2026-11-24T20:32:43.249Z - task-done: T20: Increase large-review limits and approve affordable plan expansion automatically
- 2026-11-24T20:32:43.839Z - task-done: T22: Verify large-plan policy and tier assignments on PR 9264
- 2026-11-24T20:32:53.070Z - ac-confirmed: AC8: Hosting and effective bases recorded separately. Three files and line counts match the pinned GitHub diff. (signed: local automated verification [stated])
- 2026-11-24T20:32:53.808Z - ac-confirmed: AC9: Two launch paths restored the same session for their own attempt, including follow-up after restart. (signed: local automated verification [stated])
- 2026-11-24T20:32:54.532Z - ac-confirmed: AC10: Verified target, changed-file totals, selected checks and current progress in the running desktop UI. (signed: local automated verification [stated])
- 2026-11-24T20:32:55.110Z - ac-confirmed: AC11: No operator questions on the completed automatic review or the finished single-reviewer run. Pinned-plan resume is covered. (signed: local automated verification [stated])
- 2026-11-24T20:32:55.692Z - ac-confirmed: AC12: Both entry points verified in independent local runs. See review-session-verification.md. (signed: local automated verification [stated])
- 2026-11-24T20:32:56.259Z - ac-confirmed: AC13: Prepared 180 assignments, authorized within capped Auto, refused changed revisions and excess native groups; tested manual and budget limits. (signed: local automated verification [stated])
- 2026-11-24T20:32:56.859Z - ac-confirmed: AC14: All 15 actual provider/model routes matched the plan; mixed-scope fixture exercised the Light pool. (signed: local automated verification [stated])

# Flow Journal

- 2026-11-23T19:41:25.622Z - flow created
- 2026-11-23T19:47:24.862Z - task-added: T5: Subject storage: flags.json subject, session_flags, issue binding
- 2026-11-23T19:47:25.379Z - task-added: T6: Issues source repository (project repo) in keryx issues list
- 2026-11-23T19:47:25.904Z - task-added: T7: PR board GitHub-only lanes, grouping, quick filters, GitHub reason
- 2026-11-23T19:47:26.395Z - task-added: T8: PR work row, signed actions, PR-bound sessions, /review and Create Flow from session
- 2026-11-23T19:47:26.875Z - task-added: T9: Issues board GitHub grouping, repository default, work row
- 2026-11-23T19:47:27.374Z - task-added: T10: Scenario test: PR without Flow and review -> session -> /review -> link on card
- 2026-11-23T19:47:27.976Z - task-added: T11: Verify focused suites, typecheck, attachBadges/localBadge agreement
- 2026-11-23T19:47:28.524Z - task-added: T12: Mutation check of edited attention-set lines
- 2026-11-23T19:47:29.079Z - task-added: T13: Toolbar re-measure if .flows-toolbar changed
- 2026-11-23T19:47:29.702Z - task-added: T14: Docs: implementation plan stage 1 state, deviation (a) status
- 2026-11-23T19:47:30.848Z - task-done: T1: Collect remaining context
- 2026-11-23T19:47:31.541Z - task-done: T2: Implement per plan
- 2026-11-23T19:47:31.973Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-23T19:47:49.906Z - frozen: 19 criteria; checksum recorded
- 2026-11-23T19:47:50.376Z - started
- 2026-11-23T19:48:50.862Z - task-attempt: T5: started (attempt 1) — 517-T5
- 2026-11-23T19:48:51.904Z - task-attempt: T6: started (attempt 1) — 517-T6
- 2026-11-23T19:48:52.927Z - task-attempt: T7: started (attempt 1) — 517-T7
- 2026-11-23T19:58:07.656Z - task-done: T6: Issues source repository (project repo) in keryx issues list

## T6 (2026-11-23)

DONE_WITH_CONCERNS. Repository source added; owner/repo from `selectRepository(reviewRepositories(cwd))`. Concerns: root tsc/eslint not run (no root node_modules, `bun-types` missing); unrelated root tests fail for the same reason (zod missing, timeouts). One extra GraphQL hydration call per page. Desktop half of AC13 goes to T9.
- 2026-11-23T19:58:29.712Z - task-done: T5: Subject storage: flags.json subject, session_flags, issue binding

## T5 (2026-11-23)

DONE_WITH_CONCERNS. `subject` in flags.json, `_keryx/session_flags`, issue binding writes `{kind:\"issue\"}`; Desktop `SessionSubject`, `sameSubject`. Concerns: the Desktop notice when keryx returns no subject (AC8 failure path) moves to T8; no backfill for issue sessions bound earlier; flags.json has no lock (pre-existing); root tsc not run (no root node_modules); `src/acp/shell-profile.test.ts` AC7 real-pipe tests time out locally (spawn, unrelated).
behavior_change (needs_operator by the worker): non-github.com issues bind without `subject`. Orchestrator decision, no operator question: `issues-board.ts` `assertRef` already refuses any host other than github.com, so such issues never reach the board; the frozen AC8 names github.com.
- 2026-11-23T20:00:01.262Z - task-done: T7: PR board GitHub-only lanes, grouping, quick filters, GitHub reason

## T7 (2026-11-23)

DONE_WITH_CONCERNS. GitHub-only lanes (status/role), quick filters and grouping in `.review-context`, `drawnLanes`, newest-first, GitHub-only reason. Attention-set lines unchanged; adjacent edits ReviewBoard.tsx:252 (setGrouping after setFilters) and :388 (filterReviews gets viewer) — T12 mutation-checks :388 since it feeds the hidden-attention hint. Three stage 0 DOM tests pinning the outdated note on the card were folded into the AC4 test; `reviewNote` must reappear in the T8 work row. DOM tests for AC2/AC3 were written after code and checked by mutations instead of a red run. `.review-context` wrapping not measured.
- 2026-11-23T20:00:30.163Z - task-attempt: T8: started (attempt 1) — 517-T8
- 2026-11-23T20:19:50.259Z - task-done: T8: PR work row, signed actions, PR-bound sessions, /review and Create Flow from session

## T8 (2026-11-24)

DONE_WITH_CONCERNS. Work row (PrWorkRow, 24px fixed), signed actions incl. Issue card buttons, PendingSubjects binding with older-keryx notice, openSubjectSession, usePendingFlowLinks, session header links (SessionSubjectLinks), /review preselect. Desktop tsc + `bun test src` 1004/0 (orchestrator re-ran).
Concerns: T7 had broken `ProjectNavigation.dom.test.tsx` (my T7 check ran only src/review; lesson: run `bun test src` at each Desktop boundary); T8 fixed and extended the shared App fixture. App-level Create Flow path not end-to-end tested (hook-level only) — T10 scenario covers what it can. Not checked in the real app: row in narrow lanes, menu placement, list width 1000px.
behavior_changes flagged needs_operator (10). Orchestrator accepted the implemented choice for each, without an operator question, because each follows the spec wording or keeps the same-structure rule, and lists them in the PR description for the owner: (1) review slot state words; (2) merged/closed PR without review: disabled "Run review"; (3) session menu button "More"; (4) unsaved session shown as "New session (not saved yet)" to prevent duplicates; (5) older keryx: transcript notice; (6) Create Flow replaces the composer draft of an existing bound session; (7) Create Flow before the first flow list loads links nothing; (8) list view gains a "Keryx work" column, min-width 1000px; (9) Issue "Open session" → "Open in session", text buttons; (10) header link to a PR outside the loaded scope opens no panel.
- 2026-11-23T20:20:06.915Z - task-attempt: T9: started (attempt 1) — 517-T9
- 2026-11-23T20:20:32.562Z - task-done: T13: Toolbar re-measure if .flows-toolbar changed
- 2026-11-23T20:26:41.792Z - task-done: T9: Issues board GitHub grouping, repository default, work row

## T9 (2026-11-24)

DONE_WITH_CONCERNS. Issues grouped Open · Closed (Closed only under the filter), stage filter removed, source "Project repository" default with stored preference winning, IssueWorkRow (Flow, session). Desktop tsc + `bun test src` 1016/0; root issues-board test 9/0 (orchestrator re-ran). The worker edited `src/integrations/issues-board.test.ts` (outside its list) because its AC5 test pinned stage grouping.
behavior_changes accepted by the orchestrator (listed in the PR for the owner): issue card buttons replaced by work-row links ("Flow · <stage>"); "Open question" label kept when the stage is needs_answer and no session is bound; no session menu on issues — the issue binding backend keeps one session per issue and viewer (`withIssueBinding`), so "another or new session" for an Issue (R5) is a known gap of stage 1, not done; Project board cards drop the separate stage text.

## T12 mutation check (2026-11-24)

Attention-set lines: the diff of `ReviewBoard.tsx` since `b147408a8` touches no line of `carriedAttention`, `seeded`, `seedFor`, the seed load, `attentionPrs`, the write-back or `stale` (only the import line names `needsViewerAttention`); `needsViewerAttention` in `model.ts` is byte-identical. Adjacent edited line `ReviewBoard.tsx:399` (`visible` memo, feeds the hidden-attention hint): mutation `filterReviews(snapshot.cards, filters, q, snapshot.viewer)` → `filterReviews(snapshot.cards, filters, q)` fails 2 tests of `ReviewBoard.dom.test.tsx` (67 pass, 2 fail); restored. evidence: this entry.
- 2026-11-23T20:27:11.310Z - task-done: T12: Mutation check of edited attention-set lines
- 2026-11-23T20:27:19.698Z - task-attempt: T10: started (attempt 1) — 517-T10
- 2026-11-23T20:28:01.241Z - task-done: T14: Docs: implementation plan stage 1 state, deviation (a) status
- 2026-11-23T20:31:29.447Z - task-done: T10: Scenario test: PR without Flow and review -> session -> /review -> link on card
- 2026-11-23T20:33:52.825Z - task-added: T15: Fix root tsc errors in server.ts and issue-session.test.ts (exactOptionalPropertyTypes)
- 2026-11-23T20:33:53.559Z - task-attempt: T15: started (attempt 1) — 517-T15
- 2026-11-23T20:36:20.165Z - task-done: T15: Fix root tsc errors in server.ts and issue-session.test.ts (exactOptionalPropertyTypes)

## T15 and verification (2026-11-24)

Root `bunx tsc --noEmit -p .` (after `bun install --frozen-lockfile` at the root) found 8 errors from T5 (server.ts cast target, issue-session.test.ts narrowing); fixed in T15, root tsc exit 0. Desktop: `bunx tsc --noEmit` exit 0, `bun test src` 1016 pass / 0 fail. Root focused: desk-run-store, board-badges, organize, shell-session-organize, session/issues, issues-board — 67 pass / 0 fail.

First-green gate (Phase 3 step 4): answered by the dispatching session's brief, whose finish line is "Draft PR открыт", not a merge; no hardening question asked. The review-orchestrator round on the PR and the completion choice (Phase 4) are left to the operator: the flow stays in-progress with a draft PR, nothing merged.
- 2026-11-23T20:47:03.788Z - task-done: T11: Verify focused suites, typecheck, attachBadges/localBadge agreement
- 2026-11-23T20:51:42.451Z - task-added: T16: Fix CI root typecheck: issues/model.ts must not import platform via review/prWork
- 2026-11-23T20:51:42.809Z - task-attempt: T16: started (attempt 1) — 517-T16
- 2026-11-23T20:56:23.744Z - task-done: T16: Fix CI root typecheck: issues/model.ts must not import platform via review/prWork

## T16 (2026-11-24)

CI "Lint and typecheck" on #1300 failed: root tsc pulled `apps/desktop/src/platform/*` (Tauri modules) through `issues/model.ts` → `review/prWork.ts`. `boundSessions` moved to `acp/types.ts`. Worker reproduced CI by hiding `@tauri-apps`: HEAD fails, fix passes. Root tsc 0, Desktop tsc 0, Desktop tests 1016/0.
Broad local root run (src/acp src/session src/integrations src/review): 6976 pass, 5 fail — all ~5s timeouts in rewind/replay/byte-cap tests, outside the change; CI Core tests decide.
- 2026-11-23T21:21:21.125Z - task-added: T17: Fix round 1 review findings on PR #1300 (2 blocker, 6 major, 9 minor)
- 2026-11-23T21:21:21.797Z - task-attempt: T17: started (attempt 1) — 517-T17 fix round 1
- 2026-11-23T21:40:56.537Z - task-done: T17: Fix round 1 review findings on PR #1300 (2 blocker, 6 major, 9 minor)

## Review round 1 on PR #1300 (2026-11-24)

Package `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1300`, head 6a2a3031f. Wave 1: 11 reviewers (10 on slice-02, logic and testing-practices on slice-01). Operator chose "Сначала исправить" and then "override": wave 2 (slice-02/03/04 for 12 reviewers incl. review-pr-contract) not run in round 1; recorded in operator-decisions.json. Wave D premise judge not run. Findings ingested: 32 (2 blocker, 6 major, 9 minor, 15 info). Verifier: HL-001 confirmed by execution (research-evidence/verify-F-001-1.txt), HL-002 unverifiable; the verification file was discarded by ingest (format), recorded here instead. Deviations of this round: memory searched twice (second with --json after plan) → readiness `memory-outside-stage` needs an operator waiver; caller token not exported (log read blocked) → readiness item 10 not observable.

## T17 fix round 1 (2026-11-24)

Fixed LG-001 (AC4 blocker), HL-001/DG-001/LG-002 (Create Flow: one request ↔ one package, claimed packages, 15-min window, several → none), HL-002 (subjectOpener in-flight guard), FE-001/DG-002/LG-003 (focus carries repo, cleared by App), TP-001 (App-level AC9 + issue session slot tests), AR-001/DG-005 (one prFlows resolver at 4 sites), PF-001 (prWorkIndex, stable callbacks), DG-003 (onOpenSession prop removed), DG-004 (.review-note removed), UX-001 (outline-offset -2px), UX-002 (warn tone), TP-002, TP-003, LY-001. Mutants M19, M23, M38, M39, M40, M42 now red. Desktop tsc 0, `bun test src` 1034/0, root tsc 0 (orchestrator re-ran). Attention-set lines: 0 edited (diff since 6a2a3031f).
Behavior changes accepted by the orchestrator, listed for the owner: Create Flow window 15 min (diverged from "next turn": turn end and flow refresh are unordered); review progress only in the slot title, "Transcript updated" stamp gone from the card; a header focus for another repo stays armed until that repo is shown; new PR sessions also link a Flow found via a bound session; launch dialog preselects the newest of several Flows; a repeat press during an open reuses it (flow prompt not applied to that session); warn tone for needs-answer/publication-pending.
Left: ARCH-2 re-export, IssueWorkRow per-row sessions, refused subject write stays pending (info).

## Review round 2 owner decisions (2026-11-24)

Operator (AskUserQuestion in this session): HL-001 → "Подтверждение (Recommended)": no silent auto-link; when exactly one new package appears inside the pending window, the work row offers "Link Flow #N?" with Link / Dismiss; flags.json is written only on Link; a pending request is registered only when the flow prompt was actually filled (closes LG-008). Wave 2 of round 2 → "Довести волну 2".
- 2026-11-24T05:26:50.183Z - ac-updated: AC9: ""Create Flow" on a PR card opens the PR-bound session with a prefilled flow prompt naming the PR URL; the first new flow package that appears while that request is pending is linked to the session (`flow` flag) and shown as the Flow link on that PR card; when several new packages appear, none is linked automatically (R6) [verify: exec `cd apps/desktop && bun test src`]" -> ""Create Flow" on a PR card opens the PR-bound session with a prefilled flow prompt naming the PR URL; when exactly one new flow package appears while exactly one Create Flow request with a filled prompt is pending (bounded window), the PR work row offers "Link Flow #<id>?" with Link and Dismiss; only Link writes the session `flow` flag, after which the Flow shows on that PR card; Dismiss, several new packages or several pending requests link nothing (R6) [verify: exec `cd apps/desktop && bun test src`]" (Owner decision 2026-11-24 in review round 2 (HL-001): no silent link by arrival time; the link is confirmed by the user. Recorded in journal.md 'Review round 2 owner decisions'.)
- 2026-11-24T05:26:50.378Z - ac-updated: AC8: "Subject storage: `_keryx/session_flags` accepts `subject` {kind "pr"|"issue", repo, number, url}, refuses an invalid one, persists it in `flags.json` so a fresh read (restart) returns it, and `null` unlinks it; an Issue session bound by `withIssueBinding` carries `subject.kind = "issue"`; when keryx replies without `subject`, Desktop still opens the session and shows a notice that the binding was not saved (spec AC8, failure scenario) [verify: exec `bun test src/session/organize.test.ts src/acp/shell-session-organize.test.ts src/session/issues`]" -> "Subject storage: `_keryx/session_flags` accepts `subject` {kind "pr"|"issue", repo, number, url, optional repositoryId}, refuses an invalid one, persists it in `flags.json` so a fresh read (restart) returns it, and `null` unlinks it; an Issue session bound by `withIssueBinding` carries `subject.kind = "issue"`; when keryx stores the session but replies without `subject` (older keryx), Desktop keeps the session open and shows a notice that the binding was not saved, at the latest after the session's first turn (spec AC8, failure scenario) [verify: exec `bun test src/session/organize.test.ts src/acp/shell-session-organize.test.ts src/session/issues`]" (Review round 2 PC-004: keryx stores a new session only after its first turn, so the older-keryx notice cannot appear before it; criterion text aligned with that fact, and optional repositoryId named.)
- 2026-11-24T05:26:59.546Z - task-added: T18: Fix round 2 (A): PR board, Create Flow confirmation, sessions, App fixtures
- 2026-11-24T05:26:59.729Z - task-added: T19: Fix round 2 (B): Issues source fallbacks, flags.json lock, issue subject backfill, backend tests
- 2026-11-24T05:26:59.911Z - task-added: T20: Fix round 2 (C): PR body, implementation plan, user docs
- 2026-11-24T05:27:00.670Z - task-attempt: T18: started (attempt 1) — fix round 2 A
- 2026-11-24T05:27:00.853Z - task-attempt: T19: started (attempt 1) — fix round 2 B
- 2026-11-24T05:44:30.458Z - task-done: T19: Fix round 2 (B): Issues source fallbacks, flags.json lock, issue subject backfill, backend tests
- 2026-11-24T05:53:04.638Z - task-done: T18: Fix round 2 (A): PR board, Create Flow confirmation, sessions, App fixtures

## Review round 2 on PR #1300 and its fix round (2026-11-24)

Package `.metaproject/reviews/2026-11-23-review-flow-github-com-mrciphersmith-keryx-pull-1300-r02`, head 88e3faba9, round 2 (fallback-first: round 1 has no completion evidence; its 32 findings attached as prior). 12 reviewers, 3 waves over 5 slices (29 dispatches; review-frontend and review-pr-contract drivers created by hand because `slice` had not written them). Ingested 44 findings: 1 blocker (HL-001, decided by the operator), 3 major (RG-001 confirmed, TP-R2-001 confirmed, HW2-001 unverifiable), 27 minor, 13 info. Wave D premise judge not run (HL-001 answered by the operator directly). AC8 and AC9 re-frozen with `keryx flow ac update` (reasons recorded there).
T18 (a7e…) and T19 (80ef58bd5) fixed: HL-001 (Link Flow #N? offer, Link/Dismiss), LG-008, LG-011, DG-006/UX-007, DG-007, LG-009, AR-003, TP-R2-001..005, LG-015, PF-005; RG-001/UX-008/LG-013 (Assigned to me fallback, 410 mapping, update-keryx hint), HW2-001 (per-session flags lock), DG-009 (up to 3 pages), LG-012/PC-003/DG-010 (subject backfill unless unlinked), PF-003, TP-R2-006..009. All named mutants red. Desktop tsc 0, `bun test src` 1051/0; root tsc 0; root focused 44/0. Attention-set lines: 0 edited.
Deferred info: PF-006/HW2-002 (one nodes hydration per request), AR-002, AR-004..006, PF-002, LG-004, LY-002/LY-004 (need real-engine measurement), UX-003..006.
Behavior changes accepted by the orchestrator (listed for the owner in the PR body): offer has no expiry once shown, Dismiss claims the package; foreign-repo header link shows a banner; session switch during open → no prompt and no request; merged PR keeps "publication pending" text without warn tone; Assigned-to-me fallback only for the default (unstored) source; up to 3 GitHub pages per Issues load; flags write may wait up to 3 s for the lock; subject backfill can re-link a pre-version unlink once.
Docs left for T20: PR body, implementation-plan stage-1 state, docs/docs/guides/desktop-issues.md, docs/docs/cli-reference.md (PC-001, PC-002, PC-004, LG-010, DG-008).
- 2026-11-24T06:06:20.351Z - task-done: T20: Fix round 2 (C): PR body, implementation plan, user docs

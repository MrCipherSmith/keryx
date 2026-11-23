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

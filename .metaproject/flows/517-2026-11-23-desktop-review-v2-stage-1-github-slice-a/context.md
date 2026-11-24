# Context

Worktree: this flow runs in `.claude/worktrees/eager-montalcini-d39bf1`, branch
`feat/desktop-review-v2-stage1`, cut from `origin/main` at `b147408a8`.

## Requirements

- `docs/requirements/keryx-desktop-review-v2/prd.md` R1–R7, R12
- `docs/requirements/keryx-desktop-review-v2/specification.md` — "Pull requests", "Issues",
  "Открыть в сессии", "Хранение", acceptance criteria 1, 2, 8, 9, 12, 13, 14, 15
- `docs/requirements/keryx-desktop-review-v2/implementation-plan.md` — "Этапы" row 1, "Состояние этапа 0",
  "Передача следующим этапам", D5, D6
- Stage 0 journal: `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/journal.md`

## How Issue ↔ session ↔ Flow is stored today (first step of the stage, read for this flow)

- Session flags live in `<sessionDir>/flags.json` (`src/session/organize.ts`): `archivedAt`,
  `pinnedAt`, `flow` (flow package dir). Written through the ACP extension `_keryx/session_flags`
  (`src/acp/server.ts` `handleSessionFlags`), read into `SessionInfo._meta.keryx`
  (`apps/desktop/src/acp/types.ts` `sessionFlags`). Desktop links a new session to a Flow through
  `pendingFlow` + `applyPendingFlow` in `apps/desktop/src/session/useAcpSession.ts` (keryx lists a
  session only after its first save, so the link is retried after the first turn).
- An Issue session is bound by `src/session/issues/issue-session.ts` `withIssueBinding`: a private
  record `<keryxDataDir>/issue-sessions/<digest>.json` (launch: issue ref, viewer, project, sessionId,
  flow) plus a marker `<sessionDir>/issue-link.json` holding only the digest. `readSessionFlags`
  exposes only `hasIssue: true`; Desktop cannot tell which issue a session belongs to.
- A Flow created for an Issue records `source: {type: "github-issue", ref: <url>}` in `flow.json`
  (`src/flow/issue-source.ts`). Flows have no PR source; a FlowCard knows a PR only via `prUrl`
  (set by `keryx flow implemented --pr`). `FlowCard` comes from Rust (`src-tauri/src/flows`).
- PR "Open in Sessions" (`App.tsx` `openSessionWith`) creates a new session, links it to a Flow only
  when a Flow already has that `prUrl`, and prefills the composer with the URL. No PR binding.

Decision for this flow: introduce `_meta.keryx.subject` (`flags.json` `subject`) for both kinds, as the
specification prefers. PR sessions get it from Desktop through `_keryx/session_flags`; Issue sessions
get it from `withIssueBinding` when the session is bound. The private issue record stays as is.
No Rust change: `issues_request` passes the request JSON through to `keryx issues <action>`.

## Code map

- PR board: `apps/desktop/src/review/model.ts` (lanes, filters, reasons), `ReviewResults.tsx` (cards,
  list), `ReviewBoard.tsx` (load, attention set, toolbar), `ReviewFilters.tsx`, `styles/review.css`.
- Must not break: attention set in `ReviewBoard.tsx` (`carriedAttention`, `seeded`, `seedFor`,
  `attentionPrs`, `stale`) pinned by `ReviewBoard.dom.test.tsx`; `attachBadges`
  (`src/review/desk-run-store.ts`) ≡ `localBadge` (`src/review/board-badges.ts`); toolbar container
  queries at 1100/760px in `styles/review.css`.
- Sessions in App: `App.tsx` (`linkedSessions`, `openSessionWith`, `workOn`, review launch dialog with
  `draftReview.target`), `/review` parsing `session/commandRunner.ts`.
- Issues: `apps/desktop/src/issues/model.ts` (`groupForRow`, `STAGES`, `SOURCES`, filters),
  `IssuesBoard.tsx`, `IssueFilters.tsx`; backend `src/integrations/issues-board.ts` (`listIssuePage`,
  REST `/issues?filter=<source>`), `src/commands/issues.ts`.

## Baseline

No local Rust toolchain; Rust is verified only in CI.

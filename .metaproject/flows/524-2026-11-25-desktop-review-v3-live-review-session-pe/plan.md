# Implementation Plan

Status: approved (design owner-approved; layout decisions recorded in docs/requirements/keryx-desktop-review-v3/implementation-plan.md)

## Approach

Spec: docs/requirements/keryx-desktop-review-v3/specification.md. Two independent lanes after a shared portable contract file:

1. Contract (orchestrator): `src/review/review-state-id.ts` — portable `reviewStateId(repo, number, viewer?)`, `REVIEW_STATE_DIR`, `reviewStateRelativeDir(id)`; importable from the webview.
2. Backend lane: `src/review/review-state.ts` (schema v1 types, read/validate, open with the round rule, round/publish/mark/note updates with transition checks, file lock + atomic write + journal line per write, list) and `src/commands/review-state.ts` (`keryx review state open|round|publish|mark|note|show|list`, `--json`), wired from `src/commands/review.ts` and its help; the "Desktop review state" section in both copies of review-orchestrator SKILL.md.
3. Desktop lane: `apps/desktop/src/review/reviewTurn.ts` (pure builders for the start and continue turn texts); `App.tsx` `startSessionReview` opens the PR-bound session through the existing `subjectOpener` (or uses the requesting session for the `/review` dialog) and `sendPrompt`s the start turn instead of `review_run start`; returns the current history snapshot with `startedSessionId`; `RunLaunchDialog` accepts it; `SessionReviewActivity` Continue sends the continue turn into the shown session instead of `review_run continue`; busy session → visible refusal, no queue.

Rejected: Desktop writing review.json (owner decision V2); literal `/review` turn (keryx ACP `/review` is the review-inbox view); moving packages under rounds/rNN (breaks prior-round discovery and gates).

## State × event matrix

Surfaces: the start action (board slot / Reviews tab / session dialog) and the session review card's Continue.

| state \ event | Run review pressed | Apply in /review dialog | Continue pressed | session switched while opening |
|---|---|---|---|---|
| PR has a bound idle session | that newest bound session opens and receives the start turn (AC5) | — | — | the turn still goes to the resolved session id; the view shows it only if still shown |
| PR has no bound session | a new session opens, is bound via subject, receives the start turn (AC5) | — | — | same |
| requesting session idle | — | the start turn goes into the requesting session (AC6) | — | — |
| target session busy (turn running) | no turn sent, no detached start, visible refusal (AC8) | same (AC8) | no turn sent, error shown in the card (AC8) | — |
| session card with continuable v2 run | — | — | continue turn into the shown session, no `review_run continue` (AC7) | — |
| v2 data in runs.sqlite | board slot, Reviews tab and session card still show it (AC9) | — | — | — |

## Risks

- The App-level navigation fixture encodes v2 behaviour (detached start, "board launch does not submit a prompt"); it is rewritten on purpose for v3 and must still cover the v2 display paths.
- Skill-side state writes depend on the agent following the section; live session status does not.

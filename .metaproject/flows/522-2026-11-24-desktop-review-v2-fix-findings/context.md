# Context

Base: `origin/main` at 58470cb3e (stage 4 merge, #1302). Branch `feat-/reverent-lederberg-d8cadb`.

## Requirements

- `docs/requirements/keryx-desktop-review-v2/prd.md` R7 (card actions incl. «Исправить замечания» on own PR), R11.
- `specification.md` § «Исправить замечания» (creates a fix Flow bound to the PR) and acceptance criterion 15 (the action has a visible label; shown only on the viewer's own PR).
- `implementation-plan.md` stage-4 row lists the action; «Состояние этапа 1» says "Fix review comments" is not shown (stage 4).

## Existing code reused

- `apps/desktop/src/review/prWork.ts`: `flowPrompt`, `openSubjectSession`/`subjectOpener`, `PendingFlowLink`, `resolveFlowLinks` (stage 1 Create Flow).
- `apps/desktop/src/App.tsx` `openPrSession`, `createPrFlow`, `usePendingFlowLinks` (registers the pending link only when the prompt was filled into the shown session).
- `apps/desktop/src/reviews/ReviewPanel.tsx` (Review panel, stage 2), `ReviewsView.tsx` (passes App callbacks), `reviews/model.ts` (pure labels).
- `src/review/review-entity.ts` `ReviewSummary`: `card` (`ReviewCard` with `author`, `state`, `url`), `findings` counts of the reference attempt, `reviewed` range, `rounds` (newest first, attempts newest first with `state`, `reviewed`, `archived`).
- `keryx review desk-run status --json --repo --repository-id --viewer --number --id <run>` returns the run history with `result.report` (src/review/desk-run-service.ts).
- Flow `prUrl` is written only at `keryx flow implemented`; the PR binding before that is the session's `flow` flag written by Link.

## Tests

- `apps/desktop/src/reviews/model.test.ts`, `apps/desktop/src/reviews/ReviewPanel.dom.test.tsx`, `apps/desktop/src/reviews/ReviewsView.dom.test.tsx`, `apps/desktop/src/review/prWork.test.ts`; App wiring: `apps/desktop/src/shell/ProjectNavigation.dom.test.tsx` running `apps/desktop/src/test/app-work-row.fixture.tsx`.
- Runner: `bun test` from `apps/desktop`.

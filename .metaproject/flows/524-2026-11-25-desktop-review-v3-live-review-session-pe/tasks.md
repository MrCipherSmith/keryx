# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title | Definition |
|----|------|-------|------------|
| T1 | context | Collect remaining context | Code paths of start/continue, session registration, package scanners, ACP `/review` (recorded in the spec's «Основания») |
| T2 | implement | Implement per plan | Contract `src/review/review-state-id.ts`; backend lane (store + `keryx review state` CLI + skill section); Desktop lane (`reviewTurn.ts`, `startSessionReview`, `RunLaunchDialog`, `SessionReviewActivity` continue) |
| T3 | test | Add/adjust tests and make them pass | `src/review/review-state.test.ts`, `src/commands/review-state.test.ts`, `apps/desktop/src/review/reviewTurn.test.ts`, `SessionReviewActivity.dom.test.tsx`, the rewritten v3 parts of `app-navigation.fixture.tsx` |
| T4 | review | Self-review and prepare draft PR | review-orchestrator on the PR, at most 2 rounds, fix blockers and majors only, minors deferred |
| T5 | docs | Write docs/requirements/keryx-desktop-review-v3 | README, prd, specification, implementation-plan in Russian (AC1) |
| T6 | verify | Run related suites, typecheck and health | root `bun test` for the touched files, `bun --cwd apps/desktop test` related suites, `tsc --noEmit` for root and Desktop |

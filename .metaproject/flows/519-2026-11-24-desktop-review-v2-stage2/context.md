# Context

Base: `origin/main` at `a5d1ab236` (stage 0 merged, Flow 516, PR #1294). Branch `feat/desktop-review-v2-stage2`.

## Sources of truth

- `docs/requirements/keryx-desktop-review-v2/prd.md` — R4 (rest), R8, R12.
- `docs/requirements/keryx-desktop-review-v2/specification.md` — «Сущности», «Состояние Review», «Хранение», «Экраны → Reviews», «Контракты данных», acceptance 11 and 16.
- `docs/requirements/keryx-desktop-review-v2/implementation-plan.md` v0.1.3 — stage 2 row, «Передача следующим этапам», «Что этап 0 оставил в коде», D1–D6.
- Flow 516 package: `.metaproject/flows/516-2026-11-23-desktop-review-v2-stage0/` (journal, mutation list for the attention set).

## Code map

| Area | File | Notes |
|---|---|---|
| Attempt store | `src/review/desk-run-store.ts` | `runs` table, `requestAttempt` (inside the dispatch transaction), `recordExisting` (imported session packages), `history`, `attachBadges` (SQL projection), `readLocalBadges` opens the store **read-only** and must work on an unmigrated database |
| Attempt types | `src/review/desk-run-types.ts` | `DeskRun`, `continuation.previousId` links only same-range continuations (O12) |
| Badge rule | `src/review/board-badges.ts` | `localBadge`; SQL `attachBadges` must stay in parity (store test compares them per query condition) |
| Store tests | `src/review/desk-run-store.test.ts`, `src/review/board-badges.test.ts` | parity fixture lives in the store test |
| Board CLI | `src/commands/review-board.ts` | `keryx review board --json` modes; GitHub reads via `projectGithubConnection`, `boardGraphql`, `listActiveReviewCards` (`src/review/board.ts:201`) |
| Rust bridge | `apps/desktop/src-tauri/src/review.rs` | `review_board` command builds CLI args in `board_read_args`; unit tests at the bottom. No local Rust toolchain: CI only |
| Desktop platform | `apps/desktop/src/platform/review.ts`, `reviewRuns.ts` | `invoke("review_board", …)`, `invoke("review_run", …)` |
| PR board | `apps/desktop/src/review/ReviewBoard.tsx` | attention set (`carriedAttention`, `seeded`, `seedFor`, seed load, `attentionPrs`, write-back, `stale`) — protected; indicator; toolbar holds `ProjectReviewRules` |
| PR panel | `apps/desktop/src/review/ReviewDetail.tsx` | tabs Discussion / Checks / Keryx review / Automation; the Keryx review tab renders `ReviewRuns`, `ReviewRunDialog`, launch dialog |
| PR card | `apps/desktop/src/review/ReviewResults.tsx`, `model.ts` | `needsViewerAttention` (local review clauses = deviation b), "Review again" label (decision d), `secondaryNote` (F-024) |
| Shell | `apps/desktop/src/shell/AppShell.tsx`, `apps/desktop/src/App.tsx` | `View` union, tab list with shortcuts, `reviewIndicator` |
| Toolbar CSS | `apps/desktop/src/styles/review.css` | container queries at 1100px and 760px (deviation c) |

## Parallel stage 1 (PR #1300, branch `feat/desktop-review-v2-stage1`, not merged)

Touches `ReviewBoard.tsx` (props, quick filters, grouping, focus, work row), `ReviewResults.tsx` (rewrites the card: removes the icon review action including "Review again", removes `secondaryNote`, adds `PrWorkRow`), `model.ts` (status/role lanes, quick filters, `laneReason`), `App.tsx`, `AppShell.tsx` (3 lines), `ProjectNavigation.dom.test.tsx`, `review.css`. It does not touch `ReviewDetail.tsx`, the store or the CLI. Stage 2 keeps its edits in those shared files to the minimum the stage needs; the expected conflicts are listed in the PR body.

## Memory and constraints

- `keryx` on PATH is an installed build, not the working tree (memory: stale-installed-keryx-binary). Exercise new CLI code with `bun src/cli.ts …` or tests.
- No Rust toolchain on this Mac: `review.rs` changes are verified only by CI.
- Agent conduct: no AI attribution, commits only at task boundaries by the orchestrator, no `git stash`, no `git add -A`.

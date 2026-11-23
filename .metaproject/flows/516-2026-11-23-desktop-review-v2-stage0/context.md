# Context

## Sources

- Audit of the review module and the Pull requests tab, this session (2026-11-23).
- Requirements package `docs/requirements/keryx-desktop-review-v2/` — specification.md table "Основания" (O1–O19), implementation-plan.md stage 0.

## Code map

| Concern | Files |
|---|---|
| Lane, filter, lane reason | `apps/desktop/src/review/model.ts`, `model.test.ts` |
| Board state, sort, tab indicator, toolbar markup | `apps/desktop/src/review/ReviewBoard.tsx`, `ReviewBoard.dom.test.tsx` |
| Lanes and cards rendering | `apps/desktop/src/review/ReviewResults.tsx` |
| Toolbar and board styles | `apps/desktop/src/styles/flows.css`, `apps/desktop/src/styles/review.css` |
| Card badge from local runs | `src/review/board-badges.ts`, `src/review/board-types.ts` |
| SQL that selects runs for badges | `src/review/desk-run-store.ts:388-445`, `desk-run-store.test.ts` |
| Badge equality on the client | `apps/desktop/src/review/ReviewBoard.tsx:57-62` (`badgesEqual`) |
| Detail panel launch label | `apps/desktop/src/review/ReviewRuns.tsx:26-38` (`launchAction`) |

## Facts

- `localBadge` is shared by Desktop live history and the SQLite projection; both must agree (`board-badges.ts:27`).
- `ReviewCard.localReview.runState` already has `"other-revision"` for an active run on another range.
- The SQL admits a finished run only when its requested or reviewed range equals the card's range; a finished run on an earlier head never reaches `localBadge`.
- Board JSON crosses the Tauri boundary through `review_board`; whether `review.rs` types the card or passes JSON through was not read. A worker that adds a card field must check it and report.
- Tests: `cd apps/desktop && bun test src/review` (Desktop, DOM tests included); `bun test src/review/desk-run-store.test.ts` (backend). Baseline on this branch: both green.
- No local Rust toolchain on this machine; Rust is verifiable only in CI.

## Constraints

- `.metaproject/rules/process/git-concurrency.mdc`: no `git stash`, no `git add -A`.
- Code search through `keryx ctx rg`; bare `rg`, `grep` and `cat` are blocked by a hook.

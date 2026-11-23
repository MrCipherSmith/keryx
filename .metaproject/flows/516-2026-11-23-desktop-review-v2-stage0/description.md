# Desktop Review v2 stage 0: PR board fixes without model change

Status: formalized
Source: user description (origin: human-request)
Requirements: docs/requirements/keryx-desktop-review-v2/ (PRD R1, R2, R12 in part; implementation-plan stage 0)

## Problem

The Desktop Pull requests board mixes GitHub pull request state with local Keryx review state. Five defects are fixable without changing the data model:

1. A pull request with an active review passes every filter except search (`apps/desktop/src/review/model.ts:40`).
2. Active reviews are sorted to the top, so cards reorder on review events (`apps/desktop/src/review/ReviewBoard.tsx:323`).
3. The "Done" lane is always drawn and is empty under the default filter (`apps/desktop/src/review/ReviewResults.tsx:95-98`).
4. The tab indicator lights for any open pull request with a review request to anybody or with changes requested, regardless of whose pull request it is (`apps/desktop/src/review/ReviewBoard.tsx:203`).
5. After the author pushes a commit, the finished review of the previous head vanishes from the board card (`src/review/desk-run-store.ts:416-423`); it stays only in the history inside the detail panel.
6. The board toolbar wraps to a second row when the detail panel is open (seen live at 1440x900).

## Expected Outcome

Filters hide what they should, cards keep their order when a review starts or ends, the empty lane is gone, the tab indicator means "something is addressed to me", a finished review of an earlier head stays visible on the card as outdated, and the toolbar stays on one row.

## Outcome criteria

- Запрос (дословно): «Создавай фло оформляй все и начинай имлементацию» (source: claude-code session 2026-11-23, operator message)
- Эффект (формализация агента): на доске Pull requests фильтры не имеют исключений, порядок карточек не зависит от событий ревью, результат ревью прошлого коммита остаётся виден на карточке как устаревший.
- Как наблюдать (предложение агента): на PR с активным ревью включить фильтр по другому автору — карточка скрыта; после нового коммита в PR с завершённым ревью карточка показывает «Outdated review».

## Out of Scope

- Lanes computed from GitHub only, the Keryx links row, "Open in session" binding (stage 1).
- The Review entity and Reviews tab (stage 2), head-move reconciliation (stage 3), the shared registry (stage 4).
- Team membership for the tab indicator: a review request to a team is not matched to the viewer in this stage.
- Rust code in `apps/desktop/src-tauri`.

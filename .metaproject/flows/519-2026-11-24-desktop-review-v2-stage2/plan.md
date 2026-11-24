# Plan

Four implementation tasks in dependency order (T5 → T6 → T7 → T8), then verification, review and docs. Each implementation task owns a disjoint set of files except where noted.

## T5 · Store: Review, rounds and attempts (`src/review/desk-run-store.ts`, `desk-run-types.ts`, `board-badges.ts`, tests)

Schema (created by the writable constructor, idempotent):

```sql
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, viewer TEXT COLLATE NOCASE NOT NULL,
  closed_at TEXT, on_head_move TEXT NOT NULL DEFAULT 'ask' CHECK (on_head_move IN ('ask','follow','ignore')),
  UNIQUE (repo, pr, viewer));
-- runs gains, when missing (PRAGMA table_info): review_id TEXT, round INTEGER, previous_run_id TEXT
CREATE INDEX IF NOT EXISTS review_rounds ON runs(review_id, round);
```

`repo` is the repository id, as in `runs.repo`. `viewer` keeps the NOCASE collation of `runs.viewer`, so `Me` and `me` are one Review (D3: the account is part of the key).

Assignment rule — one function, used both for the migration of an existing database and after every insert (`requestAttempt`, `recordExisting`); it only touches rows with `review_id IS NULL`, so it is idempotent and never renumbers an assigned row. Unassigned rows are processed in `(json createdAt, rowid)` order:

1. Review: the row of `reviews` for `(repo, pr, viewer)`, created with a random UUID when absent.
2. Round and link:
   - `continuation.previousId` names an assigned row of the same Review → that row's round; `previous_run_id` = `previousId`.
   - else a row of the same Review already has the same `baseSha..headSha` → that round; `previous_run_id` = the newest attempt of that round (a retry).
   - else a new round `max(round)+1` (1 for the first); `previous_run_id` = the newest attempt of the previous highest round, or NULL for round 1.
3. The migration runs inside one immediate transaction in the writable constructor; the per-insert call runs inside the caller's transaction (`requestAttempt` is called inside the dispatch transaction; `recordExisting` gets its own `atomic`).

A package imported later with an older `createdAt` gets the next round number instead of renumbering existing rounds: round numbers that were shown are never changed. This is recorded as a known limitation.

Projection: `history()` and `decode()` add `reviewId`, `round`, `previousRunId` from the columns to each `DeskRun` (new optional fields in `desk-run-types.ts`); `save()` must not write them into `details`.

Read-only stores (`readLocalBadges`, `readLocalActiveReviewNumbers`) open databases that may predate the migration: every query that reads the new columns checks `PRAGMA table_info(runs)` and substitutes `NULL` when they are absent. Read-only paths never migrate.

Badge: `BadgeRun` gains `round?: number | null`; `localBadge` puts `round` on `outdated` (`outdated.round`, the round of the stale run) when known. `attachBadges` selects `r.round` (or NULL) and passes it through, so the parity test keeps holding for every query condition; extend the parity fixture with rows that carry rounds.

Tests:
- Migration test on a copy of a working database: a fixture built with **main's exact old DDL** (copy the `CREATE` statements from `a5d1ab236`) and representative rows — two PRs, two viewers including a case variant, three ranges on one PR in shuffled insert order, a continuation, an archived and a deleted decision, an `existing` package, queued/running/failed/completed states — copied to a temp dir, opened writable. Assert: attempt count unchanged; every run has a `review_id` that exists in `reviews` (exactly one Review per run); `(repo, pr, viewer)` maps to one Review; round numbers and `previous_run_id` per the rule; a second open changes nothing; the old read-only path (`attachBadges` through a read-only store) works on the unmigrated copy.
- "One PR with three historical runs is one Review with rounds" (plan stage 2 exit criterion).
- New-attempt assignment: start, retry on the same range, continuation, new head.
- Parity test extended with rounds.

## T6 · Reviews read model and CLI (`src/review/review-entity.ts` new, `src/commands/review-reviews.ts` new, review command router, `apps/desktop/src-tauri/src/review.rs`, `apps/desktop/src/platform/review.ts`)

`DeskRunStore.reviewRows(repositoryId, viewer)` returns, per Review, its rounds and attempts without reports or session histories (ids, states, ranges, `result.reviewed`, coverage, findings counts, verdict, publication outcome, source, decision, options.flowId, usage totals, createdAt/finishedAt, pending-question flag, `closed_at`, `on_head_move`). Attempts with decision `archive`/`delete` are left out; a Review whose attempts are all left out is not listed.

`review-entity.ts` (pure, unit-tested): `reviewState(latest attempt, closed)` per the specification table — `closed` (Review `closed_at`, or PR merged/closed) → `queued` → `running` (`running`/`cancelling`) or `needs_answer` (running manual attempt with a pending question) → `published` (finished attempt with `result.reviewed` and publication `published`) → `ready` (finished — `completed`/`partial`/`budget` — with `result.reviewed`) → `stopped` (anything else: `failed` incl. `recoverable`, `cancelled`, `blocked`, `skipped`, finished without a reviewed range). `freshness(reviewedHead, prHead, compare?)` → `current` | `behind {commits|null, rewritten}`. `reviewNeedsViewer(review)` → `needs_answer`, `ready` with publication not decided (`pending` or unknown), `stopped`.

CLI `keryx review reviews --json [--repo owner/name]`: resolve the repository and GitHub connection like `review board`, read viewer login and repository id with one GraphQL query, list `reviewRows`, read the PR cards of those numbers with `listActiveReviewCards`, and for each Review whose last reviewed head differs from the PR head read `repos/{repo}/compare/{reviewed}...{head}` (at most 25 per call; failure → `commits: null` plus a warning). Output `{version: 1, repo, repositories, repositoryId, viewer, fetchedAt, reviews: ReviewSummary[], warnings}`; a `ReviewSummary` carries `id`, `number`, `card` (the PR `ReviewCard` or null), `state`, `freshness`, `onHeadMove`, `rounds` (number, base/head, `previousRunId` of its first attempt, attempts newest first), `latestRound`, `findings` of the latest reviewed round, `publication`, `source` (`manual` | `scheduled` | `existing`), `flowId`, `tokens`. A missing `runs.sqlite` returns an empty list and creates nothing. Update `BOARD_USAGE`/help and `docs/docs/cli-reference.md`.

Rust: `review_board` gets `reviews_only: Option<bool>`; `board_read_args` returns `["review","reviews","--json"]` (+ `--repo <validated>`) and refuses any combination with state/number/repositories/paged/cursor/badges/updated_since. Add unit-test assertions next to the existing `board_args` tests. Platform: `fetchReviews(cwd, repo?)` in `apps/desktop/src/platform/review.ts`, plus the browser/dev mock if the platform layer has one.

## T7 · Reviews tab (new `apps/desktop/src/reviews/`, `AppShell.tsx`, `App.tsx`, `ReviewDetail.tsx`, `ReviewBoard.tsx` props only)

- Navigation (D4): `View` gains `"reviews"`; `PROJECT_VIEWS` order Sessions ⌘1, Flows ⌘2, Reviews ⌘3, Pull requests ⌘4, Issues ⌘5, Metaproject ⌘6; the existing key handling follows the list. Reviews has its own indicator dot (`reviewsIndicator: "attention" | null`, text "Review waiting on you").
- `ReviewsView`: toolbar (heading + count, search by title/#number, filter selects for state, freshness, source, a "Show closed" toggle, Board/List, Refresh, **Review rules** — `ProjectReviewRules` moves here from the Pull requests toolbar); board columns in order Running (`queued`,`running`) · Waiting on you (`needs_answer`,`ready`,`stopped`) · Behind · Published · Closed (only when Show closed). Column choice order: `closed` → running → `needs_answer` → behind (any `behind` Review) → by state; `ready`/`published` that are behind go to Behind. Card: `#number title`, author, `Round N`, reviewed commit (7 chars) and "behind N" / "behind" / "current", findings by severity, publication state, source, Flow #id, tokens. List view: same fields as columns.
- Panel (`ReviewPanel`): Rounds timeline (round number, range, attempts with state/coverage/created time, link to the previous attempt) and the review interface moved from the PR panel: `useReviewRuns` + `ReviewRuns` + `ReviewRunDialog` + `ReviewLaunchDialog` for the PR's current range, i.e. history, report, answer, cancel, continue, publication and lifecycle actions. Prefer extracting the existing block from `ReviewDetail.tsx` into one shared component (e.g. `review/ReviewWorkspace.tsx`) over copying it.
- PR panel (`ReviewDetail.tsx`): the "Keryx review" tab and its dialogs leave; the header keeps the primary action — "Run review" opens the launch dialog as today when the PR has no Review, otherwise "Open in Reviews" (navigates to the Reviews tab with that Review selected). The Automation tab stays.
- Cross-tab navigation: App holds `reviewsFocus {number, nonce}`; the PR board gets one new optional prop `onOpenInReviews(number)` passed to `ReviewDetail`, and the PR card's review action uses it for `view`/`answer` intents (start keeps opening the PR panel launch).
- Indicator: `ReviewsView` reports `reviewNeedsViewer` over the loaded Reviews to App even while hidden (it stays mounted like the PR board); it reloads on mount, on Refresh, on tab activation and every 60 s while the tab is active and a Review is `queued`/`running`.
- Toolbar: the Reviews toolbar reuses the `.flows-toolbar` pattern; check it stays on one row at 1100/760/560px panel widths with labels collapsing like the PR toolbar (re-measure; record numbers in the journal). Removing the rules button from the PR toolbar only shrinks it.
- DOM tests (`apps/desktop/src/reviews/*.dom.test.tsx`): columns and their order, behind/published placement, filters and search, Show closed, panel rounds timeline, review interface present in the panel and absent from the PR panel, "Open in Reviews", indicator on `needs_answer`/`ready`+pending/`stopped` and off otherwise, navigation order and shortcuts.

## T8 · Pull requests board (`model.ts`, `ReviewResults.tsx`, `ReviewBoard.dom.test.tsx`, `model.test.ts`)

- Indicator (closes deviation b): `needsViewerAttention` drops the `localReview.awaitingAnswer` and `localReview.publicationPending` clauses. The attention-set code in `ReviewBoard.tsx` is not edited. Because the function feeds the attention set, run the stage-0 mutation list again for the lines this task changes (each changed line mutated → at least one test fails) and record it.
- Label (decision d): the outdated-review action reads "New review round" with a title that names the round it follows when the badge carries it ("Round N reviewed abc1234 — start a new round on the current head"). No behaviour change: it still starts an ordinary review of the current range (the update round is stage 3).
- F-024: `secondaryNote` and the text comparison go away. `laneReason` no longer falls back to the outdated note; the card and the list render the outdated note in its own line whenever the badge has one.
- Tests: model tests for the indicator (a local review waiting on the user no longer counts; the GitHub conditions still do) and the reason/note split; DOM tests for the label and the single note.

## State × event matrix (Reviews tab and the moved review interface)

| state \ event | tab switch away/back | select another Review | Refresh / 60 s reload | account or repo change | unmount |
|---|---|---|---|---|---|
| loading (first) | spinner stays; result applied on return | — | — | drop the stale response | no state write after unmount |
| loaded | list and selection kept | panel switches; the previous Review's run polling stops | list replaced; selection kept if the Review still exists, else panel closes | list cleared, panel closed, filters reset | — |
| empty (no Reviews) | empty state "No Keryx reviews yet" | — | re-read | as loaded | — |
| first load failed | error banner with Try again | — | retry; error stays inline until success | as loaded | — |
| refresh failed | keep last list, banner "Last available list" | — | retry | as loaded | — |
| access lost (`access:`/`configuration:`) | list and panel cleared, error shown | — | retry | — | — |

Indicator cells: loaded with any Review needing the viewer → dot on; empty, failed first load or access lost → dot off; refresh failed keeps the last computed value.

## Verification tasks

T9 migration on a copy of the local working database (scratch copy, counts in the journal, no data committed); T10 test suites, typecheck, lint; T11 Reviews toolbar measurement; T12 review-orchestrator on the PR; T13 docs (implementation plan «Состояние этапа 2», deviation (b) closed, CLI reference).

## Trade-offs

- Extending `review_board` with a `reviews_only` mode instead of a new Tauri command avoids a command registration that cannot be compiled locally; CI is the only Rust check either way.
- Freshness commit counts come from one compare call per behind Review; with no answer the Review shows "behind" without a number (spec allows `commits: null`).
- Moving the review interface by extracting one shared component keeps one implementation of history/publication; the PR panel keeps only the launch path for a PR without a Review.

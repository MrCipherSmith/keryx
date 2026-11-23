# Pull request context: MrCipherSmith/keryx#1294

Head 086335a01cc6ccd4c97672215d4db86d5c308dce, collection round 1, collected 2026-11-23T11:18:54.564Z.

## Intent (round 1)

**fix(desktop-review): PR board fixes without model change (Review v2 stage 0)**

## What

Stage 0 of [Desktop Review v2](docs/requirements/keryx-desktop-review-v2/README.md): fixes to the Pull requests board that need no data-model change. Flow 516.

- **Filters have no exceptions.** A pull request with an active Keryx review no longer bypasses every filter except search.
- **Stable order.** Active reviews are no longer sorted first, so cards do not reorder on review events.
- **Done lane on demand.** It is drawn only when the state filter can yield closed or merged pull requests.
- **Tab indicator means "addressed to me".** Lit by a review request to the viewer's login, changes requested on the viewer's own pull request, unread replies to the viewer, or a local review waiting on the viewer. Team review requests are not matched yet. A request handled after a load stays out of the indicator when the state filter changes.
- **Outdated review stays on the card.** After the author pushes, a card with a finished review of an earlier range shows `Outdated review · <sha>` (or `Review predates base update · <sha>` when only the base moved) and a "Review changes" action instead of looking unreviewed. The text is the card's reason when nothing ranks above it; when the card has an attention reason (failed checks, changes requested, unread reply) that reason stays first and the outdated text is a second line. The line is shown on every card with an outdated badge, merged and closed ones included. Backed by a new optional badge field `localReview.outdated`.
- **Badge query.** `attachBadges` reads each run once in a materialized CTE and returns at most one extra row per card, and only when no active run, no run requested for the card's range and no finished review of it exists.
- **Toolbar.** One row from a 560px board upward; below about 400px it wraps. Button labels hide under a 1100px toolbar, the pull request count and the watcher status text under 760px; the active-filter count stays visible. Review rules has its own icon. The Review rules and PR watcher dialogs are portaled to the document body, and focus returns to the search field when one of them closes on an account or repository change.

Also adds the requirements package `docs/requirements/keryx-desktop-review-v2/` (PRD, specification, implementation plan for stages 0-4) and the flow and review-round packages.

## Verification

- `cd apps/desktop && bun test src` - 756 pass
- `bun test src/review/desk-run-store.test.ts` (36 pass) and `src/review/board-badges.test.ts` (5 pass), each on its own
- `bunx tsc --noEmit` in `apps/desktop` and root `bun run typecheck` - clean
- Browser dev build, board without data, stand-ins for the Review rules button and the count label: toolbar on one row with no overflow at 560, 700, 820, 1101 and 1380 px; wrapped to two rows with nothing clipped at 340 px
- Badge query timing, measured once by the implementing worker on 200 pull requests x 30 runs with 200 KB reports: about 405 ms on the base commit, about 395 ms after the rewrite; badge output identical

## Review rounds

- Branch round (five of eleven planned reviewers, by operator decision): six findings, fixed in `985f8ecbc`.
- Pull request round 1 on `53c96b8af`, full roster: 1 major, 7 minor, 6 info. Fixed in `626bf776d`, `964047588`, `e08743ab4`.
- Pull request round 2 on `33fd9647a`, delta, full roster: no blocker or major, 5 minor, 7 info. The minor ones are fixed in `47721a089` and `cc42698a3`, and by this description. No review round has run on those two commits.

## Not verified

- Rust (`apps/desktop/src-tauri`) was not compiled locally; no Rust files changed. `review_board` passes the card as untyped JSON, so the new field is not dropped.
- With real board data in a running app: a card with an outdated review, the Review rules dialog, the open detail panel, the tab indicator after a filter switch (covered by a DOM test only).
- The badge query timing was not re-run after the last refactor of the statement (`47721a089`), which changes no returned row.
- Mutation pass and review-verifier did not run in any round.
- Open notes from the reviews, not addressed: the specification still says the toolbar never wraps and moves items into a menu; the requirements package says "awaiting merge"; test gaps listed as F-009 and F-022 in the review packages.

## Behaviour change to note

A merged or closed pull request with a review still running is hidden under the default Open + Draft filter (operator decision, recorded in the flow journal).


## CI: pending

- opentui native (darwin-arm64): passing
- standard-pr: passing
- team-hub-distribution: passing
- Core tests (1/4, offline): passing
- Core tests (2/4, offline): passing
- AC8 remaining tests: pending
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- deploy to GitHub Pages: skipped
- opentui native (linux-arm64): passing
- Core tests (4/4, offline): pending
- Desktop Metaproject graph and wiki acceptance: passing
- opentui native (darwin-x64): passing
- Lint and typecheck: passing
- client matrix (terminal): passing
- Core tests (3/4, offline): passing
- vscode-extension: passing
- client matrix (runtime): passing
- dependency-audit: passing
- metrics-contract: passing
- client matrix (cancel-resume): passing
- linux sandbox (bubblewrap) live smoke: passing
- opentui native (linux-x64): passing
- standard-baseline: passing
- client matrix (streaming): passing
- Issues board, Projects and session-to-Flow acceptance: passing
- wiki validate (gate) + freshness (report): passing
- mkdocs build --strict: passing
- desktop check: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)


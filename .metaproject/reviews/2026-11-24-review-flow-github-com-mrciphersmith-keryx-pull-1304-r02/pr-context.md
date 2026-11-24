# PR #1304 Desktop Review v2 stage 2: Reviews with rounds and the Reviews tab

URL: https://github.com/MrCipherSmith/keryx/pull/1304
State: OPEN

Stage 2 of Desktop Review v2 (Flow 519): attempts are grouped into Reviews with rounds, and the review interface gets its own **Reviews** tab.

Sources: `docs/requirements/keryx-desktop-review-v2/` (PRD R8, R12 and the data half of R4; implementation plan stage 2). The PR-card review link with state, round and "behind" (rest of R4) is **not** in this PR: it lands with stage 1's work row, which reads `localReview.outdated.round` and `keryx review reviews` added here. Flow package: `.metaproject/flows/519-2026-11-24-desktop-review-v2-stage2/` (plan, acceptance criteria, journal with every operator decision).

## What changes

- **Store** (`src/review/desk-run-store.ts`): a new `reviews` table keyed by repository id, PR number and reviewer account (D3, case-insensitive). `runs` gains `review_id`, `round` and `previous_run_id`. Existing databases are migrated in place when opened for writing, and new attempts are assigned when they are recorded. One rule covers both:
  - a continuation joins its predecessor's round;
  - the same base..head joins its existing round as a retry;
  - any other range opens the next round.
  - `previous_run_id` links each attempt to the one it follows.
  - Read-only badge reads still work on an unmigrated database.
  - SQL `attachBadges` stays in parity with `localBadge`, now including `outdated.round`.
- **CLI**: `keryx review reviews --json [--repo owner/name]` lists Reviews with state, freshness, rounds, latest findings, publication, source, Flow and tokens. It adds one compare call per Review that is behind, capped at 25. A missing store gives an empty list and creates nothing. Freshness is `current`, `behind {commits, rewritten}`, or `unknown` when the PR head cannot be read (operator decision). Each summary also carries `reviewed` (the commit range actually reviewed) and `archived`. Locally closed Reviews get their PR card only with `--include-closed`, which Desktop passes while "Show closed" is on. The read opens the store writable, so it migrates an older `runs.sqlite`.
- **Desktop bridge**: `review_board` gains `reviews_only`, which maps to `review reviews --json [--repo]` and is refused in combination with any other board mode.
- **Reviews tab**: the tabs are now Sessions, Flows, Reviews, Pull requests, Issues, Metaproject, on ⌘1–⌘6 (D4).
  - Board columns: Running · Waiting on you · Behind · Published, plus Closed when "Show closed" is on. A list view is also available.
  - Search, plus state / freshness / source filters.
  - The Review rules button moved here.
  - The Review panel shows the rounds timeline and the review interface: history, report, answers, publication and lifecycle. That interface was moved out of the PR panel into one shared component.
- **Pull requests panel**: the "Keryx review" tab is gone. For a PR that has a Review, the header offers "Open in Reviews"; for a PR without one it keeps its launch action.
- **Indicators**:
  - The Reviews tab lights for `needs_answer`, `ready` with publication undecided, and `stopped`.
  - The Pull requests tab no longer lights from a local review. This closes stage 0 deviation (b).
- **Outdated-review action**: relabelled "New review round". Its title names the round it follows (decision d). The action itself still starts an ordinary review; the update round is stage 3.
- **F-024**: `secondaryNote` and its text comparison are removed, and the outdated note shows once, on its own line.

## Review round 1 and fixes

Round 1 ran as a managed review on head `20e4281`, with 12 reviewers and 32 dispatches over five slices; the package is in `.metaproject/reviews/2026-11-24-review-flow-github-com-mrciphersmith-keryx-pull-1304/`. It found 8 majors; the 7 sent to a verifier were all confirmed, and the eighth set the round rule below. All are fixed in `85fa985` (backend) and `98c7b37` (Desktop), each with a test that failed before the fix:
- **Open in Reviews:** it now carries the repository, so it opens the right Review in multi-repo projects.
- **One-shot intents:** an answer intent and an Open-in-Reviews request are each used once and never replayed.
- **Indicator rule:** the Reviews indicator lights `ready` only when publication is pending. A Review that is archived, or whose PR card could not be read, does not light it unless it asks a question.
- **Indicator freshness:** the indicator stays current while the tab is hidden.
- **Archived Reviews:** they are reachable again, under "Show closed".
- **Reviewed commit:** cards show the commit range that was actually reviewed.
- **Round rule:** a return to an earlier range opens a new round (operator decision; AC1 reworded).

The minors are fixed too: docs and shortcuts, accessibility names, card-read cost and deadline, and test gaps. The full list is in `fix-round-1.md` in the flow folder. A delta review of the fixes follows.

## Verification

- Root: `bun test src/review/desk-run-store.test.ts src/review/board-badges.test.ts src/review/review-entity.test.ts src/commands/review-reviews.test.ts` pass. `bun run typecheck` and `bun run lint` are clean.
- Desktop: `bun test src` passes 1007 tests with 0 failures at `98c7b37`, and `bunx tsc --noEmit` is clean.
- CI on `20e4281`: 29 checks passed, 0 failed. A local full root run (13158 pass / 18 fail) and the review's tests-to-run (2014 pass / 18 fail) failed only on 5 s timeouts and environment checks in suites this PR does not touch, while the machine was heavily loaded.
- Migration test on a fixture built with main's exact old DDL. The migration was also run on a scratch copy of a real working database: 17 attempts before and after, 13 Reviews (equal to the number of distinct keys), round 1 × 13 and round 2 × 4, and a second open changed nothing.
- `needsViewerAttention` mutation check: 13 one-line mutations, including putting each removed local-review clause back. Every mutation failed at least one test. The attention-set code in `ReviewBoard.tsx` is unchanged.
- Browser dev build, run against real GitHub with a scratch data dir: the Reviews tab loads (empty list for this repo) and the toolbar was measured.
  - It stays on one row with nothing clipped at panel widths from 760 to 1380 px.
  - At 700 px and below it takes two rows, and three at 340 px.
  - At 560 px it needs 648 px even with every item at its minimum, so this is recorded as a known limit.

## Not verified

- Populated Review cards with real GitHub data, and the built native app.
- The Rust bridge (`apps/desktop/src-tauri/src/review.rs`): there is no local toolchain, so CI is the only check.
- Spec filters not built in this stage: publication, PR author, Flow, period.

## Expected overlap with stage 1 (PR #1300, `feat/desktop-review-v2-stage1`)

Stage 2 does not depend on stage 1 and was not rebased onto it. Expect conflicts in:
- `apps/desktop/src/review/ReviewResults.tsx`: stage 1 removes the icon review action and `secondaryNote` and adds `PrWorkRow`; stage 2 relabels the action and removes `secondaryNote`. Take stage 1's card. Its review slot can then show `outdated.round` from the badge.
- `apps/desktop/src/review/model.ts`: stage 1 rewrites the lanes and quick filters; stage 2 removes the local-review clauses from `needsViewerAttention` and the `reviewNote` fallback from `laneReason`. Keep both.
- `apps/desktop/src/review/ReviewBoard.tsx`: stage 2 adds the `onOpenInReviews` prop, routes `openReview` view/answer to it, removes `ProjectReviewRules` from the toolbar, and adds `outdated.round` to `badgesEqual`.
- `apps/desktop/src/review/model.test.ts`: both stages rewrite its import line and the outdated/base-moved tests — keep both (stage 2's `needsViewerAttention` test guards the indicator change).
- `apps/desktop/src/review/ReviewBoard.dom.test.tsx`: the Review rules tests moved to `src/reviews/ReviewsView.dom.test.tsx`, and three assertions now go to `onOpenInReviews`.
- `apps/desktop/src/App.tsx`, `apps/desktop/src/shell/AppShell.tsx`, `apps/desktop/src/shell/ProjectNavigation.dom.test.tsx`, `apps/desktop/src/test/app-navigation.fixture.tsx`: the new tab and the D4 shortcut order.
- `apps/desktop/src/styles/review.css`, `docs/requirements/keryx-desktop-review-v2/implementation-plan.md`: localized additions.

Draft: the review round runs on this PR. Do not merge.


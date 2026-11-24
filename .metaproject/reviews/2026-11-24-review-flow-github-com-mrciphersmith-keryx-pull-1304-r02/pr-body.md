Stage 2 of Desktop Review v2 (Flow 519): attempts are grouped into Reviews with rounds, and the review interface gets its own **Reviews** tab.

Sources: `docs/requirements/keryx-desktop-review-v2/` (PRD R8, R12 and the data half of R4; implementation plan stage 2). Flow package: `.metaproject/flows/519-2026-11-24-desktop-review-v2-stage2/` (plan, acceptance criteria, journal with every operator decision). The PR-card review link with round and "behind" (rest of R4) is **not** in this PR: stage 1's work row shows the review state, and this PR gives it the data: `localReview.outdated.round` and `keryx review reviews`.

Rebased onto main `666d71468` after stage 1 (PR #1300) merged. Stage 1's code was kept where the two overlapped: the attention-set lines in `ReviewBoard.tsx`, the GitHub-only lanes and the Keryx work row.

## What changes

- **Store** (`src/review/desk-run-store.ts`): a new `reviews` table keyed by repository id, PR number and reviewer account (D3, case-insensitive). `runs` gains `review_id`, `round` and `previous_run_id`. Existing databases are migrated in place when opened for writing, and new attempts are placed when they are recorded. One rule covers both:
  - a continuation joins its predecessor's round;
  - the same base..head as the **current highest** round joins it as a retry;
  - any other range, including a return to an earlier one (A, B, A), opens the next round (operator decision D-R1);
  - a queued request superseded before it started holds no round, and `previous_run_id` skips it.

  Read-only badge reads still work on an unmigrated database. SQL `attachBadges` stays in parity with `localBadge`, now including `outdated.round`.
- **CLI**: `keryx review reviews --json [--repo owner/name] [--include-closed]` lists Reviews with state, freshness, rounds, latest findings, publication, source, Flow and tokens. Each summary carries `reviewed` (the commit range actually reviewed) and `archived`. It adds one compare call per Review that is behind, capped at 25 within a 60 s budget. Freshness is `current`, `behind {commits, rewritten}`, or `unknown` when the PR head cannot be read (operator decision). Locally closed Reviews get their PR card only with `--include-closed`. The read opens the store writable, so it migrates an older `runs.sqlite`; a missing store gives an empty list and creates nothing.
- **Desktop bridge**: `review_board` gains `reviews_only`, which maps to `review reviews --json [--repo]`, and `include_closed`, which maps to `--include-closed`. Both are refused unless they are the only board mode. The Rust code (`apps/desktop/src-tauri/src/review.rs`) is checked by CI only.
- **Reviews tab**: the tabs are now Sessions, Flows, Reviews, Pull requests, Issues, Metaproject, on ⌘1–⌘6 (D4).
  - Board columns: Running · Waiting on you · Behind · Published, plus Closed when "Show closed" is on. A list view is also available.
  - Search, plus state / freshness / source filters. The Review rules button moved here.
  - The Review panel shows the rounds timeline and the review interface (history, report, answers, publication, lifecycle), moved out of the PR panel into one shared component.
- **Pull requests panel**: the "Keryx review" tab is gone. For a PR that has a Review the header offers "Open in Reviews"; for a PR without one it keeps its launch action. "Open in Reviews" carries the repository, so it opens the right Review in multi-repo projects.
- **Indicators**: the Reviews tab lights for `needs_answer`, `ready` with a publication still pending, and `stopped`. An archived Review, or one whose PR card could not be read, lights only for `needs_answer`. The Pull requests tab no longer lights from a local review (closes stage 0 deviation (b)). The indicator stays current while the tab is hidden.
- **Outdated-review action**: relabelled "New review round". Its title names the round it follows (decision d). It still starts an ordinary review; the update round is stage 3. On stage 1's work row the slot title carries the round.
- **F-024**: `secondaryNote` and its text comparison are removed; the outdated note shows once, on its own line.

## Review

- **Round 1** (head `20e4281`): 12 reviewers, 32 dispatches, 8 majors; the 7 sent to a verifier were confirmed and the eighth set the round rule above. All are fixed with red-first tests. Package: `.metaproject/reviews/…-pull-1304/`.
- **Round 2** (delta of the round-1 fixes): 15 reviewers, 9 waves, 62 results: **0 blockers, 1 major, 59 minors, 24 info**. The major (a wall-clock assertion in the compare-deadline test, confirmed by a verifier) is fixed, as is its class in the navigation fixture (real-sleep polling now uses `waitFor`). Package: `.metaproject/reviews/…-pull-1304-r02/`.
- **Capped by the operator**: only blockers and majors are fixed; the 83 minors and info notes are **deferred** and listed in `deferred-findings.md` of the round-2 package. They fall into these groups:
  - "Show closed": every toggle re-reads the whole list, it stays on after leaving the tab, and a reset while it is on can hide an access error.
  - Closed Reviews: a closed or merged Review whose head moved reads "behind" without a count, and `closed_at` has no writer, so the skip of closed cards never applies.
  - Deadlines: the card-read phase has no deadline of its own, and compares past the 60 s budget keep their `gh` processes.
  - Rare dead ends: a Review whose only runs were superseded before they started is offered "Open in Reviews" by the PR panel and the card badge, but is not in the Reviews list; the Reviews tab is blank until the GitHub account read settles.
  - Duplicated "finished attempt" sets, store/domain publication-eligibility drift, naming.
  - Test-quality items (absence-only assertions, fixtures with shapes the backend cannot produce, gaps in migration and writer tests) and doc wording (plan, spec, CLI reference, `desktop-app.md`).
  - Round-1 F-060: the outdated action title falls back to a title without a round when the badge has none.
- **For the operator**: a queued request cancelled before dispatch still opens a round and marks the Review stopped (the spec table maps cancellation to stopped).
- The round-2 ledger, ingest and `review complete` gates were **not** run. Round 1's gate still lists blast-radius, pr-files and quotes-located for the operator's waiver.

## Verification

- Root typecheck and lint clean. Desktop `tsc` clean; `bun test src` in `apps/desktop`: 1171 pass, 0 fail, on the rebased code.
- Root suites for review, commands and lib: 8180 pass; 3 failures and 1 error are 5 s timeouts under load, and the three failing suites pass when run alone with a longer timeout.
- **attachBadges/localBadge parity** (hard constraint): `src/review/desk-run-store.test.ts` and `src/review/board-badges.test.ts` pass on the rebased head, 51 tests, 0 failures (`research-evidence/badge-parity-b38e33ce8.txt` in the round-2 package).
- Migration test on a fixture built with main's exact old DDL. The migration was also run on a scratch copy of a real working database before the D-R1 round rule: 17 attempts before and after, 13 Reviews, round 1 ×13 and round 2 ×4. That copy check was **not repeated** after D-R1.
- `needsViewerAttention` mutation check (before the rebase): 13 mutations, every one failed at least one test. The attention-set lines in `ReviewBoard.tsx` are unchanged by this PR.
- Browser dev build against real GitHub with a scratch data dir: the Reviews tab loads (empty list for this repository) and the toolbar stays on one row at panel widths 760–1380 px; below 700 px it takes two rows, and at 560 px it needs 648 px even at minimum widths (a recorded limit).
- CI on the head is recorded in the PR checks; see the final status before merge.

## Not verified

- Populated Review cards with real GitHub data, and the built native app.
- The Rust bridge: no local toolchain; CI only.
- The migration copy check after D-R1, and the toolbar with a populated list.
- Spec filters not built in this stage: publication, PR author, Flow, period.

Draft: not merged.

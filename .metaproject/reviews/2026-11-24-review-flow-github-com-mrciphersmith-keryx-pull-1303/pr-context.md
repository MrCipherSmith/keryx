# Pull request context: MrCipherSmith/keryx#1303

Head 9e871b17f16a934d5568926e210c3c88d1ca7a86, collection round 1, collected 2026-11-24T08:06:57.841Z.

## Intent (round 1)

**Desktop Review v2 stage 3: publish as is after head move (D1), on_head_move (D2), prior-attempt selection**

Stage 3 of Desktop Review v2, flow 520 (`.metaproject/flows/520-2026-11-24-desktop-review-v2-stage3`). Requirements are in `docs/requirements/keryx-desktop-review-v2/`: implementation plan v0.1.3 stage 3, owner decisions D1 and D2, and the spec section "Поведение при смене head".

## Depends on stage 2 (not done yet)

The plan puts stage 3 after stage 2, because the update round belongs to the Review entity and its rounds. Stage 2 is flow 519 on `feat/desktop-review-v2-stage2`. When this PR was opened, that branch was not on origin and the rounds migration (`src/review/desk-run-store.ts`) did not exist. The owner chose to start stage 3 early, so this PR contains only the parts that do not need rounds. They are shaped to attach to rounds later without a rewrite. No rounds schema is defined here.

- **Waiting on stage 2.** Item 3 ("Review again" becomes an update round of the same Review) is not started. Flow task T8 and criterion AC7 track it. The following go with it:
  - wiring `selectPriorAttempt` into the run start;
  - relaxing the package trust rule in `prior-round.ts` and `round-record.ts` so a partial previous round is accepted;
  - the `onUpdateReview` caller in the publish dialog;
  - carrying finding answers across the update round.
- **Overlap with stage 1** (Draft MrCipherSmith/keryx#1300, which changes the board, the Issues tab, and card links in `ReviewBoard.tsx` and `model.ts`). No file overlap is expected: this PR does not touch `ReviewBoard.tsx`, `model.ts`, `board-badges.ts`, `desk-run-store.ts` or `review.css`. Stage 2 will move the review UI out of the PR panel. Whichever lands second rebases `ReviewPublishDialog.tsx`.

## What changes

1. **Publish as is after the head moved (D1).** Applies when the PR is open with the reviewed base and a newer head. `desk-publish` returns `headMoved: { reviewedHead, currentHead }` and forces verdict `comment` with inline comments off. The body opens with:
   > Reviewed commit `<sha>`. The pull request has moved to `<sha>` since; this review does not cover the newer commits.

   The review posts with `commit_id` set to the reviewed head. The current head is part of the digest and the body, so another push makes the preview stale and the submit fails with `stale:`. Before the write, the subject is checked against the head shown in the preview. Automatic publication still refuses a moved head. A changed base or a closed PR keeps today's refusal. The dialog shows both commits, locks the verdict and inline controls, and labels the action "Publish as is for `<short sha>`". It also accepts an optional "Update review to `<sha>`" action, which no caller passes until item 3.
2. **`on_head_move` (D2).** New `src/review/head-move.ts` with `ask | follow | ignore`.
   - A manual review defaults to `ask`; a rule-triggered review defaults to `follow`.
   - `parseOnHeadMove` reads a missing or unknown stored value as the default, so stage 2 can store it as a nullable column.
   - `headMoveResponse` encodes the spec table.
   - There is no storage yet.
3. **Previous-attempt selection (item 4, the part that does not need rounds).** New `src/review/update-round.ts`. `selectPriorAttempt` returns the newest `DeskRun` attempt with accepted findings.
   - Partial attempts count, and the result marks them `partial`.
   - The settings key is not compared.
   - It skips imported, failed, cancelled, unreviewed, deleted and archived attempts.
   - `prior-round.test.ts` pins that a previous round recorded under different settings is still chosen.

## Decisions taken in the flow (please check)

- In the head-moved case, Save locally stores the forced settings (`comment`, no inline). This attempt can only be published as is from now on.
- Placement of "Update review to …" (first footer button) is provisional. The spec calls it the primary action, so it gets revisited when item 3 connects it.
- In the head-moved case, General comment can still be switched off. The existing message then refuses the submit.

## Verification

- `bun test src/review/desk-publication.test.ts` — 14 pass. The tests for each failure path were checked by reverting the guarding line and watching the test fail.
- `bun test src/review/head-move.test.ts src/review/update-round.test.ts src/review/prior-round.test.ts` — pass. For the partial-state and settings-key rules, a mutation was confirmed to make a test fail.
- `cd apps/desktop && bun test src/review` — 123 pass. Desktop `tsc --noEmit` and root `bun run typecheck` are clean. `eslint` is clean on the changed `src/review` files.
- The Desktop `.tsx` files are excluded from the root ESLint config, so they are not linted.

## Not verified

- No scenario was run on a real pull request, including a commit pushed during a round followed by publishing as is from Desktop (AC9). Coverage is unit and DOM tests only.
- The Desktop Rust side (`review_publish` passes `Value` through; no Rust change) is verified only in CI, because there is no local Rust toolchain.
- Item 3 and acceptance criteria 4–7 of the spec are not implemented (see above).


## CI: pending

- standard-pr: pending
- opentui native (linux-x64): pending
- standard-baseline: passing
- Lint and typecheck: pending
- linux sandbox (bubblewrap) live smoke: pending
- Issues board, Projects and session-to-Flow acceptance: passing
- client matrix (cancel-resume): pending
- Desktop Metaproject graph and wiki acceptance: passing
- vscode-extension: passing
- opentui native (darwin-arm64): pending
- dependency-audit: passing
- Core tests (2/4, offline): pending
- AC8 remaining tests: pending
- Core tests (4/4, offline): pending
- team-hub-distribution: pending
- deploy to GitHub Pages: skipped
- Core tests (1/4, offline): pending
- opentui native (linux-arm64): passing
- opentui native (darwin-x64): passing
- Core tests (3/4, offline): pending
- desktop check: pending
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- metrics-contract: passing
- wiki validate (gate) + freshness (report): passing
- mkdocs build --strict: passing
- client matrix (runtime): passing
- client matrix (streaming): passing
- client matrix (terminal): passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)


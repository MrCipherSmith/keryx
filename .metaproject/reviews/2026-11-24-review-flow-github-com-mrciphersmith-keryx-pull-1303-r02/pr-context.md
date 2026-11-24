# Pull request context: MrCipherSmith/keryx#1303

Head 412258583206e539ce61727b9c4d71bb12fda3a0, collection round 1, collected 2026-11-24T08:49:59.996Z.

## Intent (round 1)

**Desktop Review v2 stage 3: publish as is (D1), update round of the same Review, on_head_move (D2)**

Stage 3 of Desktop Review v2, flow 520 (`.metaproject/flows/520-2026-11-24-desktop-review-v2-stage3`). Requirements are in `docs/requirements/keryx-desktop-review-v2/`: implementation plan v0.1.3 stage 3, owner decisions D1 and D2, and the spec sections "Поведение при смене head" and "Раунд обновления".

## Stacked on stage 2: merge stage 2 first

This branch is rebased onto `feat/desktop-review-v2-stage2` at `98bec5904` (flow 519). That point contains the Review/round/attempt store, `keryx review reviews` and the Reviews tab. Stage 2 has no PR yet, so this PR targets `main` and its diff also shows the stage 2 commits.

The stage 3 commits are the ones after `98bec5904`. To review only stage 3, use `git diff 98bec5904..feat/desktop-review-v2-stage3`.

Stage 2 is still changing its T8 (the PR-board indicator, the "New review round" label, F-024). If stage 2 is rebased or force-pushed, this branch gets rebased again.

**Overlap with stage 1** (Draft MrCipherSmith/keryx#1300, which changes the board, the Issues tab, and card links in `ReviewBoard.tsx` and `model.ts`): this PR does not touch `ReviewBoard.tsx`, `model.ts`, `ReviewResults.tsx`, `board-badges.ts`, `desk-run-store.ts` or `review.css`.

## What changes

1. **Publish as is after the head moved (D1).** This applies when the PR is open on the reviewed base, the head is newer, and GitHub's compare API reports the reviewed commit as an ancestor of the head (`ahead`).
   - `desk-publish` returns `headMoved` and forces verdict `comment` with inline comments off.
   - The body starts with "Reviewed commit `<sha>`. The pull request has moved to `<sha>` since; this review does not cover the newer commits."
   - The review posts with `commit_id` set to the reviewed head.
   - Another push makes the preview stale. Before the write, the head shown in the preview is checked again.
   - These cases keep today's refusal: a rewritten history (diverged or behind), a failed compare, a changed base, or a closed PR.
   - Automatic publication refuses a moved head before it makes any GitHub read.
   - The dialog shows a warning that names both commits and explains why the controls are locked.
2. **Update the review (item 3).** In the head-moved dialog, the primary action is "Update review to `<sha>`". It starts an attempt on the current head with the reviewed attempt's options. Stage 2's store makes that attempt round N+1 of the same Review.
   - **Builds on the previous round.** One rule chooses the previous attempt: `selectPriorAttempt`, over the earlier rounds of the same Review. It replaces the old rule (completed, complete coverage, same settings). A partial previous round or one with other settings now feeds the next round in `delta` mode with its findings attached.
   - **Partial previous round.** It is accepted only through a `desk-partial` record in the machine-local round registry. Only Desktop's executor writes that record, when it hands on a package from the user's own run store. Packages a PR can commit gain no trust. Everything a partial round did not prove it covered is reviewed as new code.
   - **Answers carry over.** Keep and dismiss answers from the previous round's draft are pre-selected in the new round's draft, matched by finding id. The new round's own draft always wins.
3. **`on_head_move` (D2).** New `src/review/head-move.ts`: `ask | follow | ignore`, defaulting to `ask` for a manual review and `follow` for a rule-run review. `parseOnHeadMove` reads a missing or unknown stored value as the default, and `headMoveResponse` encodes the spec table.
4. **Tests for the previous-round rules** cover a partial previous round and changed settings, in the `prior-round`, `desk-run-service`, `desk-run-executor` and `update-round` tests.

`docs/docs/desktop-app.md` describes publishing as is.

## Decisions taken in the flow (please check)

- "Update review" starts the attempt directly with the previous attempt's options; it does not open the launch form. The user stays in the Reviews panel.
- If the board has not seen the push yet, it is refreshed. If the current head already has an attempt, nothing new starts.
- With a moved head, Save locally stores the forced settings (`comment`, no inline).
- A failed compare refuses the as-is variant: it fails closed.
- A retry on the same range builds only on earlier rounds, not on another attempt of its own round.

## Review

- **Round 1:** review-orchestrator on PR head `9e871b17f`, 12 reviewers. It found 0 blockers, 1 major and 11 minors.
  - The major: the as-is variant was offered after a force-push.
  - Every finding was fixed in T11 or recorded as a stage 3 T8 obligation, except one minor: two different rules for choosing the previous attempt. T12 merged them into one.
- **Round 2** covers T11–T13.

## Verification

- `bun test` passes for the review suites listed in the flow's acceptance criteria.
- The Desktop `src/review` and `src/reviews` suites pass, and root and Desktop `tsc` are clean.
- `eslint` passes on `src/review`.
- The Desktop `.tsx` files are excluded from the root ESLint config, so they are not linted.

## Not verified

- No scenario was run on a real pull request (AC9). That includes a commit pushed during a round, then publishing as is or updating from Desktop. Coverage is unit and DOM tests only.
- The GitHub compare call and the 422 behaviour were exercised only through fixtures.
- `runDeskWorker` was not run end to end, and no live Desktop update round was run.
- The Desktop Rust side (`review_publish` passes JSON through; there is no Rust change in stage 3) is verified only in CI. There is no local Rust toolchain.
- Not in this PR (plan stage 3 and spec items outside this flow's scope):
  - checking the head at the wave boundary in the executor;
  - acting on `on_head_move` while a round runs (the `follow` auto-queue, the `ask` notice);
  - watcher `push` events updating a Review;
  - writing a per-source `on_head_move` default into `reviews` (the column currently defaults to `ask` for every Review).


## CI: pending

- standard-pr: passing
- linux sandbox (bubblewrap) live smoke: pending
- client matrix (cancel-resume): pending
- opentui native (darwin-x64): pending
- vscode-extension: passing
- dependency-audit: passing
- deploy to GitHub Pages: skipped
- opentui native (linux-arm64): passing
- team-hub-distribution: pending
- desktop check: pending
- Core tests (3/4, offline): pending
- Lint and typecheck: passing
- Desktop Metaproject graph and wiki acceptance: passing
- client matrix (streaming): passing
- Core tests (1/4, offline): pending
- client matrix (runtime): pending
- standard-baseline: passing
- Core tests (4/4, offline): pending
- opentui native (darwin-arm64): pending
- macOS real-host legs — OS sandbox + TUI pty launch: pending
- Core tests (2/4, offline): pending
- wiki validate (gate) + freshness (report): passing
- mkdocs build --strict: passing
- AC8 remaining tests: pending
- opentui native (linux-x64): passing
- metrics-contract: passing
- client matrix (terminal): pending
- Issues board, Projects and session-to-Flow acceptance: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)


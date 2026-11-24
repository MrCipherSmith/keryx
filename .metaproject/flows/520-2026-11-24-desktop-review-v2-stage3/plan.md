# Plan

## Approach

### A. Publish as is for the reviewed commit (D1) — `src/review/desk-publication.ts`, `desk-publication-types.ts`, `apps/desktop/src/review/ReviewPublishDialog.tsx`

- The server classifies the PR against the run: `current` (open, same base and head), `head-moved` (open, same base, different head), or `moved` (closed, or the base changed). Only `head-moved` gets the new variant; `moved` keeps today's refusal.
- `PublicationState` gains `headMoved?: { reviewedHead: string; currentHead: string }`. Its presence means "this draft is the as-is variant for the reviewed commit".
- In the `head-moved` case the server forces the verdict to `comment` and inline comments off (the current PR diff does not place lines on the old commit), and prepends one first line to the body: ``Reviewed commit `<reviewedHead>`. The pull request has moved to `<currentHead>` since; this review does not cover the newer commits.`` The current head is part of the digest, so a further push makes the preview stale.
- Submit re-verifies the subject: open, base unchanged, head equal to the previewed current head (a new helper next to `verifyDeskSubject`, which stays strict for every other caller). `commit_id` stays the reviewed head.
- `automatic` publication with a moved head stays refused.
- The dialog shows a status line naming both commits, disables the verdict choice and the Inline checkbox, and labels the primary button "Publish as is for `<short sha>`". An optional `onUpdateReview` prop renders "Update review to `<short sha>`" as the first action when a caller provides it; no caller provides it until item 3.

### B. `on_head_move` (D2) — new `src/review/head-move.ts`

- `ON_HEAD_MOVE = ["ask", "follow", "ignore"]`, `type OnHeadMove`, `defaultOnHeadMove(source)` (`manual` and `existing` → `ask`, `scheduled` → `follow`), `parseOnHeadMove(value, source)` (unknown or missing → default; this is how stage 2 reads a nullable column), and `headMoveResponse(mode, phase)` encoding the spec table (running: ask → offer "update after" and "stop and restart"; follow → queue update after finish; ignore → nothing).
- No storage. Stage 2 adds the `reviews.on_head_move` column and reads it through `parseOnHeadMove`.

### C. Previous-round selection (item 4, round-independent part) — new `src/review/update-round.ts`

- `selectPriorAttempt(attempts)` over `DeskRun` records (an Attempt keeps the `DeskRun` format per the spec): newest attempt, not `existing`, of the current scope, with a recorded reviewed range and accepted findings, state `completed` or `partial`; the options key is ignored. Returns the attempt and `partial: boolean` (for spec step 4, uncovered area).
- Not wired into `desk-run-service.ts` yet: today the executor copies only a closed previous package and the package trust rule in `prior-round.ts` requires completion evidence, so wiring it alone would change nothing observable and would half-implement item 3. Wiring plus the trust-rule change go with item 3.
- `prior-round.test.ts` gains a test that a previous round recorded with different review settings is still chosen (settings are not part of the package candidate), pinning that invariant for the update round.

### D. Item 3 — blocked on stage 2

After A–C, `git fetch origin` and check `feat/desktop-review-v2-stage2` for the rounds migration (`src/review/desk-run-store.ts`). If present, rebase onto it and implement the update round; if not, leave T-item3 blocked and report.

## Trade-offs

- Forcing inline off for the as-is variant loses inline placement; placing lines on an old commit would need its diff and is not needed for a Comment.
- `headMoved` as a state field instead of a new request kind keeps the request contract and the draft file unchanged; the user's explicit act is pressing the distinctly labelled button, and the digest binds the preview they saw.

## Do not break

- Attention-set logic in `apps/desktop/src/review/ReviewBoard.tsx`: not touched by this plan.
- `attachBadges` ↔ `localBadge` parity: not touched.
- Toolbar container queries in `apps/desktop/src/styles/review.css`: not touched.

## State × event matrix (publish dialog)

| state \ event | preview loads | head moves again before submit | user presses primary | settings change |
|---|---|---|---|---|
| current head | as today | submit fails `stale:`; preview marked stale | Submit review | as today |
| head moved, PR open, base same | status line names both commits; verdict locked to Comment; Inline disabled; primary "Publish as is for `<sha>`" | digest differs → `stale:` error, preview stale, nothing posted | posts a COMMENT review on the reviewed commit with the first line | verdict/inline changes are ignored by the server (forced) |
| base moved or PR closed | blocked reason as today | — | disabled | as today |
| automatic publication, head moved | refused, needs a decision in Desktop | — | — | — |

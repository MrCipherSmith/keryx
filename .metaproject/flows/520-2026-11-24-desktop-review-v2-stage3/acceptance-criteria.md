# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: When the pull request is open with the reviewed base and a different head, the `desk-publish` preview returns `headMoved` with both commits, verdict `comment`, inline off, and a body whose first line names the reviewed commit and says the pull request moved on; submit posts a `COMMENT` review with `commit_id` equal to the reviewed head. [verify: exec `bun test src/review/desk-publication.test.ts`]
- AC2: With a moved head, a submit whose settings ask for another verdict or inline comments still posts a `COMMENT` with no inline comments; a head that moved again after the preview fails with `stale:` and posts nothing; automatic publication with a moved head posts nothing; a changed base or a closed pull request keeps today's refusal. · sensitive: failure-scenario [verify: exec `bun test src/review/desk-publication.test.ts`]
- AC3: The publish dialog with a moved head shows both commits, disables the verdict choice and inline comments, and labels the primary action "Publish as is for" the short reviewed commit; with the current head the dialog is unchanged. [verify: exec `sh -c 'cd apps/desktop && bun test src/review/ReviewRuns.dom.test.tsx'`]
- AC4: `on_head_move` has the values `ask`, `follow`, `ignore`; a manual review defaults to `ask` and a rule-triggered review to `follow`; a missing or unknown stored value reads as the default. [verify: exec `bun test src/review/head-move.test.ts`]
- AC5: The previous-attempt selection accepts the newest partial attempt with accepted findings and an attempt run with different settings, and rejects imported, failed, cancelled and unreviewed attempts. [verify: exec `bun test src/review/update-round.test.ts`]
- AC6: `findPreviousRound` still chooses a previous round recorded under different review settings. [verify: exec `bun test src/review/prior-round.test.ts`]
- AC7: "Review again" on a card with an outdated review starts an update round of the same Review on the current head, with the previous round's findings attached. [verify: none — blocked on stage 2 rounds; criterion is rewritten with its test when item 3 is implemented]
- AC8: Backend review tests, the Desktop review suite, typecheck and lint pass on the branch; the attention-set code, `attachBadges`/`localBadge` and the toolbar container queries are unchanged by this flow. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet origin/main -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts apps/desktop/src/styles/review.css'`]
- AC9: The scenario on a real pull request with a commit pushed during a round, then published as is from Desktop. [verify: judged]

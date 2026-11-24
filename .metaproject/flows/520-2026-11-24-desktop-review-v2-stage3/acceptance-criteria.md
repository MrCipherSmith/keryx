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
- AC7: A new attempt on a newer head of the same Review (stage 2 round N+1, started by "Review again" / "New review round" or "Update review") builds on the previous round: after a partial previous round with accepted findings it runs in mode delta with a non-empty prior-findings list and the area the partial round did not cover planned as unreviewed; after a previous round run with different settings it still gets the previous findings; the previous-attempt rule exists once (selectPriorAttempt), the old options-key rule is gone. [verify: exec `bun test src/review/prior-round.test.ts src/review/update-round.test.ts src/review/desk-run-service.test.ts src/review/desk-run-executor.test.ts`]
- AC8: Backend review tests, the Desktop review suites, typecheck and lint pass on the branch; this flow leaves the attention-set code, attachBadges/localBadge and the toolbar container queries as stage 2 left them. [verify: invariant `sh -c 'bun test src/review && cd apps/desktop && bun test src/review src/reviews && cd ../.. && bun run typecheck && bunx eslint src/review apps/desktop/src/review && git diff --quiet 98bec59046d0ce30500b341e8c18ba5b767069bb -- apps/desktop/src/review/ReviewBoard.tsx src/review/board-badges.ts src/review/desk-run-store.ts apps/desktop/src/styles/review.css'`]
- AC9: The scenario on a real pull request with a commit pushed during a round, then published as is from Desktop. [verify: judged]
- AC10: In the publish dialog with a moved head, "Update review to <sha>" starts a new round of the same Review on the current head; the keep/dismiss answers given in the previous round's draft are pre-selected in the new round's publication draft for findings with the same finding id. [verify: exec `sh -c 'bun test src/review/desk-publication.test.ts && cd apps/desktop && bun test src/reviews src/review'`]

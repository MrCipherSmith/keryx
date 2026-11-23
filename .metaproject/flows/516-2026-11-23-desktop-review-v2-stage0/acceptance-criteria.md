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

- AC1: `filterReviews` returns no card that fails a selected filter, including a card whose local review is active; a test with an active review and a non-matching author filter expects an empty result. [verify: exec `sh -c 'cd apps/desktop && bun test src/review/model.test.ts'`]
- AC2: The order of visible cards does not depend on `localReview`; a board test with an active review on the second card keeps the snapshot order. [verify: exec `sh -c 'cd apps/desktop && bun test src/review/ReviewBoard.dom.test.tsx'`]
- AC3: The Done lane is rendered only when the state filter includes closed or merged; under the default filter the board has three lanes. [verify: exec `sh -c 'cd apps/desktop && bun test src/review/ReviewBoard.dom.test.tsx'`]
- AC4: The tab indicator is "attention" only when an open pull request has the viewer among requested reviewers, or is authored by the viewer with changes requested, or has unread replies addressed to the viewer, or has a local review awaiting an answer or a publication decision; a review request to another login alone leaves it off. [verify: exec `sh -c 'cd apps/desktop && bun test src/review/ReviewBoard.dom.test.tsx'`]
- AC5: For a card whose only finished run with a recorded result covers an earlier head, the badge carries `outdated` with that run's reviewed head and state, while `ready` and `publicationPending` stay false; a run on the current range or an active run takes precedence. [verify: exec `bun test src/review/desk-run-store.test.ts src/review/board-badges.test.ts`]
- AC6: A card with an outdated badge shows the text "Outdated review" with the short reviewed SHA in board and list views, and the badge comparison on the client treats a changed `outdated` value as a change. [verify: exec `sh -c 'cd apps/desktop && bun test src/review'`]
- AC7: With the detail panel open at a 1440 px wide window the board toolbar occupies one row. [verify: judged]
- AC8: The Desktop review test suite, the backend review store tests, typecheck and lint pass on the branch. [verify: invariant `sh -c 'cd apps/desktop && bun test src/review && cd ../.. && bun test src/review/desk-run-store.test.ts && bun run typecheck'`]

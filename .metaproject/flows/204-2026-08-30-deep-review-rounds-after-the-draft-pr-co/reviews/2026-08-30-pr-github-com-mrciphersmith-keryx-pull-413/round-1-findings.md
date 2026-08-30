# Round 1 — findings, as raised

Four reviewers, two scopes, over `dfb9ca4a07f0d9ef9685a0122487f30f94c059cf`.

- `review-logic` (scope: diff) — 8 findings
- `review-testing-practices` (scope: diff) — 3 findings
- `review-regression` (scope: blast-radius) — 1 finding
- `review-core-boundaries` (scope: diff) — 0 findings, 64 tool calls

Every one of these was raised BEFORE the fix commit `23b43c384a02dcbd7999f29f4868771c24f5c38a`.
Round 2 verifies each against that commit. A finding is cleared only by a
verifier verdict of `refuted` against a named SHA with a method and evidence —
never by disappearing from a later round.

| id | reviewer | severity | site | claim |
|----|----------|----------|------|-------|
| logic-01 | review-logic | major | `src/flow/review-gate.ts:819` | Condition 4 passes on a stale collection: `rounds_collected > 0` is taken as proof of freshness, and `PrCommentState` records no timestamp or commit. |
| logic-02 | review-logic | major | `src/review/blast-radius.ts:764`, `src/gdskills/model-tier.ts:496,592,674` | `screenBlastRadiusFindings`, `buildTierMap`, `assignTier`, `decideDispatchModel` are documented as enforcement and have no production caller. |
| logic-03 | review-logic | minor | `src/review/pr-comments.ts:1568` | `postReplyPass` skips on row existence while two sibling readers skip on reply existence; a settled row with `reply_url: null` can never be cleared. |
| logic-04 | review-logic | minor | `src/flow/review-gate.ts:1077` | Condition 5 refuses only `verification_mode: off`; `annotate` with zero claims passes while printing that nothing was verified. |
| logic-05 | review-logic | minor | `src/gdskills/model-tier.ts:106` | `parseModelTier` returns inherited `Object.prototype` keys, bypassing the AC14 guard and resolving as a silent `light` downgrade. |
| logic-06 | review-logic | minor | `src/review/pr-comments.ts:908` | The abbreviation mask under-counts a sentence-final `etc.`, the direction the code's own comment names as dangerous. |
| logic-07 | review-logic | info | `src/flow/review-gate.ts:1006` | `flow complete --merged` compares the round's branch commit against the merge commit; different by construction for squash or rebase. |
| logic-08 | review-logic | info | `src/gdskills/model-tier.ts:441` | `ranking.sessionRank ?? 0` anchors `deep`/`light` at rank 0 for any caller passing a ranking with no session rank. |
| test-01 | review-testing-practices | blocker | `src/gdskills/model-tier.ts:496` | The tier module is a producer with no consumer: nothing in the shipped runtime calls it, so tier selection has no effect on a real run. |
| test-02 | review-testing-practices | major | `src/commands/review.ts:973,525` | `review blast-radius` and `review comments collect` have no test driving them through the real CLI — and the latter writes the record gate condition 4 reads. |
| test-03 | review-testing-practices | major | `src/commands/review.ts:588` | `--max-sentences` has zero coverage at any level and `--max-replies` none through argv; proved by mutation (87/87 stayed green). |
| regr-01 | review-regression | major | `src/review/loop.ts:275` | External comments carry a dedupe key stable across rounds, so an unanswered comment reads as a reviewer in a loop and `review loop` exits 1 from round 2. |

## What was done about each

All twelve were accepted and fixed in `23b43c38`. Three fix agents worked
disjoint file sets; each fix was proved to bite by breaking it and watching a
named test go red, then restoring.

The evidence for each fix, the test that pins it, and the mutation that proves
the test bites are in this flow's journal.

# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `REVIEW_ROUND_CAP` is 5, and the gate note for an unsatisfied gate at the cap names the cap by that constant (round cap (5)); with 4 rounds the cap is not reached, with 5 it is. [verify: exec `bun test src/flow/review-gate.test.ts`]
- AC2: The `flow-orchestrator` skill (bundled and `.metaproject` mirror, byte-identical) says "Allow at most **five** review/fix attempts" and carries no leftover "three" in the sense of that bound. [verify: exec `bun test src/gdskills/round-bound.test.ts`]
- AC3: `round-bound.test.ts` pins five for the review bound and keeps three for `job-orchestrator` and `task-implementer`, with the reason the review bound differs written next to the assertion. [verify: exec `bun test src/gdskills/round-bound.test.ts`]
- AC4: The guide `review-with-a-record.md` states the round bound as five. [verify: exec `bun test src/gdskills/round-bound.test.ts`]
- AC5: Behaviour of the gate is unchanged: the cap only adds a note and never blocks, and a finding can still be dismissed only by a human. [verify: invariant `bun test src/flow/review-gate.test.ts`]

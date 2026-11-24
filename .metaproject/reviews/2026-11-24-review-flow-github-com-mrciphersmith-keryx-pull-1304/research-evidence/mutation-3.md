# Mutation pass

Command: `bun test src/commands/review-reviews.test.ts src/review/desk-run-store.test.ts src/review/board-badges.test.ts src/review/review-entity.test.ts` (baseline exit 0, 6037 ms). Run in a scratch copy; the worktree was not written.

Bail: applied (mutants ran with --bail; baseline in full).

Cost: provenance 478 ms, copy 55213 ms, mutants 6285 ms, load 12.0/10.2/11.3.

started 2026-11-24T10:57:38.009Z, head 20e4281a2ac0, treeHash e3b0c44298fc.

Killed 0, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| S03 | src/review/desk-run-store.ts:586 | `WHERE v.repo=? AND v.viewer=? AND coalesce(json_extract(r.details,'$.decision.action'),'') NOT IN ('archive','delete')` → `WHERE v.repo=? AND v.viewer=? AND coalesce(json_extract(r.details,'$.decision.action'),'') NOT IN ('archive')` | survived | `bun test --bail src/commands/review-reviews.test.ts src/review/desk-run-store.test.ts src/review/board-badges.test.ts src/review/review-entity.test.ts` | 0 |
| S04 | src/review/desk-run-store.ts:574 | `${placement.previousRunId} AS previousRunId,         CASE WHEN r.state='recoverable' THEN 'failed' ELSE r.state END AS state,` → `${placement.previousRunId} AS previousRunId,         r.state AS state,` | survived | `bun test --bail src/commands/review-reviews.test.ts src/review/desk-run-store.test.ts src/review/board-badges.test.ts src/review/review-entity.test.ts` | 0 |

A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed.

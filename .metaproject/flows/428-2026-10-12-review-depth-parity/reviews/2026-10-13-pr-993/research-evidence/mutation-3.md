# Mutation pass

Command: `bun test src/gdskills/reviewer-triggers.test.ts` (baseline exit 0, 182 ms). Run in a scratch copy; the worktree was not written.

Killed 2, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M8 | src/review/coverage.ts:46 | `? "\uE001" : "\uE000"` → `? "\uE000" : "\uE001"` | killed |
| M9 | src/review/coverage.ts:110 | `if (gated(name) === false) {` → `if (gated(name) === true) {` | killed |

No survivor.

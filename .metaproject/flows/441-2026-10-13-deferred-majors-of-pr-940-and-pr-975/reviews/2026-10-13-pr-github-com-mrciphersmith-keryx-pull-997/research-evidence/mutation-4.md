# Mutation pass

Command: `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts src/commands/review.test.ts` (baseline exit 0, 1438 ms). Run in a scratch copy; the worktree was not written.

Killed 2, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M03-objectEnd-escape-never-set | src/review/ledger.ts:94 | `else if (char === "\\") escaped = true;` → `else if (char === "\\") escaped = false;` | killed |
| M30-fence-pointer-ignores-range-start | src/review/ledger.ts:177 | `return next < ranges.length && start >= ranges[next]![0];` → `return next < ranges.length;` | killed |

No survivor.

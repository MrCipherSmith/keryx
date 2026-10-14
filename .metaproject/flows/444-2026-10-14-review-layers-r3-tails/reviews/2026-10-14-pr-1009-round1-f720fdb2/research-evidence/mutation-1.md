# Mutation pass

Command: `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` (baseline exit 0, 12381 ms). Run in a scratch copy; the worktree was not written.

Killed 3, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| ac2-unreadable-page-dropped | src/review/layers-payload.ts:176 | `unreadable.push(page.relativePath);` → `` | survived | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 0 |
| r1-failedat-ignored | src/review/layers.ts:193 | `Date.parse(existing.graph.failedAt ?? existing.refreshedAt)` → `Date.parse(existing.refreshedAt)` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r1-failedat-not-persisted | src/review/layers.ts:427 | `failedAt: deps.now().toISOString(),` → `` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r1-window-never-expires | src/review/layers.ts:194 | `return age >= 0 && age < FAILED_RETRY_WINDOW_MS;` → `return age >= 0;` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

# Mutation pass

Command: `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` (baseline exit 0, 13317 ms). Run in a scratch copy; the worktree was not written.

Killed 4, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| ac2-unreadable-page-dropped | src/review/layers-payload.ts:183 | `unreadable.push(page.relativePath);` → `` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r1-failedat-ignored | src/review/layers.ts:198 | `Date.parse(existing.graph.failedAt ?? existing.refreshedAt)` → `Date.parse(existing.refreshedAt)` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r1-failedat-not-persisted | src/review/layers.ts:437 | `failedAt: deps.now().toISOString(),` → `` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r1-window-never-expires | src/review/layers.ts:199 | `return age >= 0 && age < FAILED_RETRY_WINDOW_MS;` → `return age >= 0;` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |

No survivor.

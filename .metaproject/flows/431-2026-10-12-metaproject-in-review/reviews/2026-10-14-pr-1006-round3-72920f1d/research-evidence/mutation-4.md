# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/review-chunks.test.ts src/flow/review-gate-coverage.test.ts` (baseline exit 0, 19444 ms). Run in a scratch copy; the worktree was not written.

Killed 2, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| r3-01-chunk-answer-opaque | src/lib/command-risk.ts:767 | `if (lowerArgs.some(isAnswer) && opaqueArgs(args)) return true; ` → `` | killed |
| r3-03-mcp-args | src/review/layers-usage.ts:91 | `for (const key of ["name", "tool"])` → `for (const key of ["name", "tool", "arguments"])` | killed |

No survivor.

# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/review-chunks.test.ts src/flow/review-gate-coverage.test.ts` (baseline exit 0, 28808 ms). Run in a scratch copy; the worktree was not written.

Killed 8, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| r3-01-opaque-args | src/lib/command-risk.ts:726 | `return completeLike && opaqueArgs(rest);` → `return completeLike && false;` | killed |
| r3-01-opaque-verb | src/lib/command-risk.ts:725 | `includes("complete") \|\| (rest[0] !== undefined && wordIsOpaque(rest[0]));` → `includes("complete");` | killed |
| r3-01-opaque-head | src/lib/command-risk.ts:681 | `if (wordIsOpaque(words[0]!)) return words.slice(1); ` → `` | killed |
| r3-01-chunk-answer-opaque | src/lib/command-risk.ts:767 | `if (lowerArgs.some(isAnswer) && opaqueArgs(args)) return true; ` → `` | survived |
| r3-01-package-exempt | src/lib/command-risk.ts:692 | `wordIsOpaque(w) && args[i - 1] !== "--package"` → `wordIsOpaque(w)` | killed |
| r3-04-keryx-only | src/lib/command-risk.ts:687 | `? words.slice(at + 1) : undefined;` → `? words.slice(at + 1) : words.slice(1);` | killed |
| r3-04-terminal | src/commands/review-chunks.ts:109 | `optionValue(rest, "--answer") !== undefined && !isTerminal()` → `false` | killed |
| r3-02-refuse-flags | src/lib/trust-routine-command.ts:159 | `if (entry.refuseFlags?.some(` → `if (false && entry.refuseFlags?.some(` | killed |
| r3-02-chunks-refuse | src/lib/trust-routine-command.ts:102 | `refuseFlags: ["--answer", "--quote"]` → `refuseFlags: []` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

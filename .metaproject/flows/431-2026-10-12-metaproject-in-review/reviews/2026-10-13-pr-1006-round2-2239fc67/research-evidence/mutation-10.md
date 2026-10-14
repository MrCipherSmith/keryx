# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/automatic-review.test.ts src/trigger src/flow src/tui/review-layers` (baseline exit 0, 56497 ms). Run in a scratch copy; the worktree was not written.

Killed 18, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| cr1-collapse-off | src/lib/command-risk.ts:703 | `  if (collapseQuoting(command).toLowerCase().includes(COVERAGE_WAIVER_FLAG)) return true; ` → `` | killed |
| cr7-recursion-off | src/lib/command-risk.ts:685 | `if (depth < 4 && words.some((w) => /\s/.test(w) && parsedCoverageWaiver(w, depth + 1))) return true;` → `` | killed |
| cr13-estimate-check-off | src/lib/command-risk.ts:718 | `if (after.includes("estimate") && after.some(` → `if (true && after.some(` | killed |
| ar2-answer | src/commands/automatic-review.ts:408 | ` && !flags.has("--answer") && !flags.has("--quote")` → ` && !flags.has("--quote")` | killed |
| ly2-current-commit | src/review/layers.ts:248 | `return existing.graphCommit === existing.prHead && (await graphIntact(packageDir, existing));` → `return await graphIntact(packageDir, existing);` | killed |
| ly5-intact-nodes | src/review/layers.ts:238 | `return (await stat(path.join(dataDir, "storage", "nodes.jsonl"))).size > 0;` → `return true;` | killed |
| cr5-opaque-dollar-only | src/lib/command-risk.ts:669 | `return /[$`]/.test(word);` → `return /[$]/.test(word);` | killed |
| ar3-quote | src/commands/automatic-review.ts:408 | ` && !flags.has("--answer") && !flags.has("--quote")` → ` && !flags.has("--answer")` | killed |
| ly12-sweep-prefix | src/review/layers.ts:334 | ` \|\| !path.basename(worktree).startsWith(WORKTREE_PREFIX)) continue;` → `) continue;` | killed |
| ly13-sweep-dir | src/review/layers.ts:334 | `if (path.dirname(worktree) !== temp \|\| ` → `if (` | killed |
| ly7-resolve-hex | src/review/layers.ts:227 | `return full !== null && /^[0-9a-f]{40,64}$/.test(full) ? full : null;` → `return full;` | killed |
| cr21-both-spellings-asis-only | src/lib/command-risk.ts:664 | `return expanded === command ? splitSegments(command) : [...splitSegments(command), ...splitSegments(expanded)];` → `return splitSegments(command);` | killed |
| cr22-both-spellings-expanded-only | src/lib/command-risk.ts:664 | `return expanded === command ? splitSegments(command) : [...splitSegments(command), ...splitSegments(expanded)];` → `return splitSegments(expanded);` | killed |
| cr23-continuation-off | src/lib/command-risk.ts:644 | `return command.replace(/\\\r?\n/g, "");` → `return command;` | killed |
| cr24-continuation-crlf | src/lib/command-risk.ts:644 | `return command.replace(/\\\r?\n/g, "");` → `return command.replace(/\\\n/g, "");` | killed |
| cr25-chunk-collapse-net-off | src/lib/command-risk.ts:725 | `return /chunks\s+estimate\b[^;&\|]*--answer/i.test(collapseQuoting(joinContinuations(raw)));` → `return false;` | killed |
| cr26-chunk-scan-depth | src/lib/command-risk.ts:719 | `if (depth < 4 && plain.some((w) => /\s/.test(w) && scan(w, depth + 1))) return true;` → `if (depth < 0 && plain.some((w) => /\s/.test(w) && scan(w, depth + 1))) return true;` | killed |
| cr27-chunk-collapse-anywhere | src/lib/command-risk.ts:725 | `[^;&\|]*--answer/i` → `[\s\S]*--answer/i` | killed |

No survivor.

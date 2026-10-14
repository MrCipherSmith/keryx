# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/automatic-review.test.ts src/trigger src/flow src/tui/review-layers` (baseline exit 0, 83301 ms). Run in a scratch copy; the worktree was not written.

Killed 19, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| cr3-words-includes-off | src/lib/command-risk.ts:665 | `if (words.some((w) => w.toLowerCase().includes(COVERAGE_WAIVER_FLAG))) return true;` → `if (false) return true;` | survived |
| cr6-opaque-sub-only | src/lib/command-risk.ts:654 | `return /[$`]/.test(word);` → `return /[`]/.test(word);` | killed |
| cr9-hex-off | src/lib/command-risk.ts:635 | `const code = x ?? u ?? big;` → `const code = u ?? big;` | killed |
| cr12-confirm-waiver-off | src/lib/command-risk.ts:626 | ` \|\| touchesCoverageWaiver(command) \|\| touchesChunkEstimateAnswer(command);` → ` \|\| touchesChunkEstimateAnswer(command);` | killed |
| cr15-answer-flag-off | src/lib/command-risk.ts:701 | `after.some((w) => w === "--answer" \|\|` → `after.some((w) => false \|\|` | killed |
| cr18-chunk-unescape-off | src/lib/command-risk.ts:698 | `const words = seg.words.map(unescapeWord).map((w) => w.toLowerCase());` → `const words = seg.words.map((w) => w.toLowerCase());` | killed |
| cr21-ansi-big | src/lib/command-risk.ts:634 | `\|U([0-9a-fA-F]{1,8})` → `` | killed |
| rv2-terminal-always | src/commands/review.ts:3881 | `if (waiver !== undefined && !isTerminal()) {` → `if (waiver !== undefined) {` | killed |
| rg1-completeness-true | src/flow/review-gate.ts:446 | `{ completeness: readString(manifest?.["status"]) !== "closed" }` → `{ completeness: true }` | killed |
| tr1-chunks | src/lib/trust-routine-command.ts:95 | `    "chunks", ` → `` | killed |
| ar1-wikiwrite | src/commands/automatic-review.ts:406 | ` && !flags.has("--write-wiki");` → `;` | killed |
| ar4-result | src/commands/automatic-review.ts:408 | `!flags.has("--quote") && absentOrUnderCwd("--result");` → `!flags.has("--quote");` | killed |
| ly1-current-head | src/review/layers.ts:247 | `if (head !== undefined && existing.prHead !== head) return false;` → `` | killed |
| ly4-intact-build | src/review/layers.ts:235 | `if (build?.commit !== layers.graphCommit) return false;` → `` | killed |
| ly7-resolve-hex | src/review/layers.ts:227 | `return full !== null && /^[0-9a-f]{40,64}$/.test(full) ? full : null;` → `return full;` | survived |
| ly10-keep-failed | src/review/layers.ts:551 | `if (graph.status === "failed" && sameHead && (await layersCurrent(input.packageDir, existing, prHead))) {` → `if (false) {` | killed |
| ly13-sweep-dir | src/review/layers.ts:334 | `if (path.dirname(worktree) !== temp \|\| ` → `if (` | survived |
| ly16-recover-call | src/review/layers.ts:540 | `      await recoverGraphDirectory(input.packageDir); ` → `` | killed |
| pl2-batch-break | src/review/layers-payload.ts:297 | `if (taken > 0 && removed + entryBytes >= overshoot) break;` → `` | killed |
| us1-size | src/review/layers-usage.ts:80 | ` \|\| info.size > MAX_TOOL_LOG_BYTES` → `` | killed |
| cc2-alnum | src/review/coverage-complete.ts:201 | ` \|\| !/[\p{L}\p{N}]/u.test(quote)` → `` | killed |
| ch3-next-lock | src/review/chunks.ts:241 | `return withChunkStateLock(packageDir, () => nextChunkLocked(packageDir));` → `return nextChunkLocked(packageDir);` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

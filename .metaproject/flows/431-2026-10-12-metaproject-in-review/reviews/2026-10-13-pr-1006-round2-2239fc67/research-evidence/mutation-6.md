# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/automatic-review.test.ts src/trigger src/flow src/tui/review-layers` (baseline exit 0, 177573 ms). Run in a scratch copy; the worktree was not written.

Killed 15, survived 8, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| cr1-collapse-off | src/lib/command-risk.ts:687 | `  if (collapseQuoting(command).toLowerCase().includes(COVERAGE_WAIVER_FLAG)) return true; ` → `` | survived |
| cr4-opaque-off | src/lib/command-risk.ts:668 | `if (words.slice(review + 1).some(wordIsOpaque)) return true;` → `if (false) return true;` | killed |
| cr7-recursion-off | src/lib/command-risk.ts:670 | `if (depth < 4 && words.some((w) => /\s/.test(w) && parsedCoverageWaiver(w, depth + 1))) return true;` → `` | survived |
| cr10-oct-off | src/lib/command-risk.ts:637 | `if (oct !== undefined) return String.fromCharCode(Number.parseInt(oct, 8) & 0xff);` → `` | killed |
| cr13-estimate-check-off | src/lib/command-risk.ts:701 | `if (after.includes("estimate") && after.some(` → `if (true && after.some(` | survived |
| cr16-chunk-recursion-off | src/lib/command-risk.ts:702 | `if (depth < 4 && seg.words.some((w) => /\s/.test(w) && scan(w, depth + 1))) return true;` → `` | killed |
| cr19-ansi-newline | src/lib/command-risk.ts:630 | `n: "\n", ` → `` | survived |
| cr22-review-complete-off | src/lib/command-risk.ts:667 | `if (review >= 0 && words.slice(review + 1).some((w) => w.toLowerCase() === "complete")) {` → `if (false) {` | killed |
| mg1-restore-off | src/review/managed.ts:840 | `if (researchBefore !== undefined) await writeFileAtomic(researchPath, researchBefore).catch(() => undefined);` → `` | killed |
| un1-waiver-off | src/trigger/unattended.ts:134 | `if (touchesCoverageWaiver(text) \|\| touchesChunkEstimateAnswer(text)) {` → `if (touchesChunkEstimateAnswer(text)) {` | killed |
| tr2-coverage | src/lib/trust-routine-command.ts:96 | `    "coverage", ` → `` | killed |
| ar2-answer | src/commands/automatic-review.ts:408 | ` && !flags.has("--answer") && !flags.has("--quote")` → ` && !flags.has("--quote")` | survived |
| ar5-chunks-pkg | src/commands/automatic-review.ts:407 | `case "chunks":         return inPackage(one("--package")) &&` → `case "chunks":         return` | killed |
| ly2-current-commit | src/review/layers.ts:248 | `return existing.graphCommit === existing.prHead && (await graphIntact(packageDir, existing));` → `return await graphIntact(packageDir, existing);` | survived |
| ly5-intact-nodes | src/review/layers.ts:238 | `return (await stat(path.join(dataDir, "storage", "nodes.jsonl"))).size > 0;` → `return true;` | survived |
| ly8-force | src/review/layers.ts:546 | `if (input.force !== true && sameHead &&` → `if (sameHead &&` | killed |
| ly11-sweep-age | src/review/layers.ts:336 | `if (age < WORKTREE_SWEEP_AGE_MS) continue;` → `` | killed |
| ly14-recover-old | src/review/layers.ts:315 | `if (missing && entry.startsWith(`${name}.old.`)) {` → `if (false) {` | killed |
| ly17-sweep-call | src/review/layers.ts:541 | `      await sweepStaleWorktrees(deps, input.projectRoot); ` → `` | killed |
| pl3-batch-bound | src/review/layers-payload.ts:295 | `taken < Math.max(1, list.length - runnerUp) &&` → `taken < 1 &&` | survived |
| us2-isfile | src/review/layers-usage.ts:80 | `if (!info.isFile() \|\| info.size` → `if (info.size` | killed |
| ch1-lock-wait | src/review/chunks.ts:24 | `{ timeoutMs: CHUNK_LOCK_WAIT_MS }` → `{ timeoutMs: 1 }` | killed |
| ch4-record-lock | src/review/chunks.ts:289 | `return withChunkStateLock(packageDir, () => recordChunkLocked(packageDir, chunkId, result));` → `return recordChunkLocked(packageDir, chunkId, result);` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

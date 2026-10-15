# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/automatic-review.test.ts src/trigger src/flow src/tui/review-layers` (baseline exit 0, 83118 ms). Run in a scratch copy; the worktree was not written.

Killed 14, survived 7, timeout 1, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| cr2-parsed-off | src/lib/command-risk.ts:688 | `  return parsedCoverageWaiver(command); }` → `  return false; }` | killed |
| cr5-opaque-dollar-only | src/lib/command-risk.ts:654 | `return /[$`]/.test(word);` → `return /[$]/.test(word);` | survived |
| cr8-ansi-off-parsed | src/lib/command-risk.ts:663 | `for (const seg of splitSegments(expandAnsiCQuotes(command))) {     const words = seg.words.map(unescapeWord);` → `for (const seg of splitSegments(command)) {     const words = seg.words.map(unescapeWord);` | survived |
| cr11-confirm-chunk-off | src/lib/command-risk.ts:626 | ` \|\| touchesCoverageWaiver(command) \|\| touchesChunkEstimateAnswer(command);` → ` \|\| touchesCoverageWaiver(command);` | killed |
| cr14-answer-eq-off | src/lib/command-risk.ts:701 | `\|\| w.startsWith("--answer="))) return true;` → `))) return true;` | killed |
| cr17-chunk-ansi-off | src/lib/command-risk.ts:697 | `for (const seg of splitSegments(expandAnsiCQuotes(text))) {       const words = seg.words.map(unescapeWord).map` → `for (const seg of splitSegments(text)) {       const words = seg.words.map(unescapeWord).map` | survived |
| cr20-ansi-quote-escape | src/lib/command-risk.ts:644 | `decodeAnsiC(body).replace(/'/g, "'\\''")` → `decodeAnsiC(body)` | survived |
| rv1-terminal-off | src/commands/review.ts:3881 | `if (waiver !== undefined && !isTerminal()) {` → `if (false) {` | killed |
| rs1-completeness-off | src/review/research.ts:55 | `options.completeness === false \|\| ` → `` | killed |
| un2-answer-off | src/trigger/unattended.ts:134 | `if (touchesCoverageWaiver(text) \|\| touchesChunkEstimateAnswer(text)) {` → `if (touchesCoverageWaiver(text)) {` | killed |
| tr3-layers | src/lib/trust-routine-command.ts:94 | `    "layers", ` → `` | killed |
| ar3-quote | src/commands/automatic-review.ts:408 | ` && !flags.has("--answer") && !flags.has("--quote")` → ` && !flags.has("--answer")` | survived |
| ar6-coverage-pkg | src/commands/automatic-review.ts:409 | `case "coverage":         return inPackage(one("--package"));` → `case "coverage":         return true;` | killed |
| ly3-current-intact | src/review/layers.ts:248 | `return existing.graphCommit === existing.prHead && (await graphIntact(packageDir, existing));` → `return existing.graphCommit === existing.prHead;` | killed |
| ly6-resolve-verify | src/review/layers.ts:226 | `["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]` → `["rev-parse", "--quiet", "--end-of-options", `${rev}^{commit}`]` | killed |
| ly9-samehead | src/review/layers.ts:546 | `if (input.force !== true && sameHead && (await layersCurrent(input.packageDir, existing, prHead))) {` → `if (input.force !== true && (await layersCurrent(input.packageDir, existing, prHead))) {` | survived |
| ly12-sweep-prefix | src/review/layers.ts:334 | ` \|\| !path.basename(worktree).startsWith(WORKTREE_PREFIX)) continue;` → `) continue;` | survived |
| ly15-builtfrom | src/review/layers.ts:404 | `if (builtFrom !== prHead) {` → `if (false) {` | killed |
| pl1-pop-files | src/review/layers-payload.ts:288 | `      files.pop();       continue;` → `      throw new Error("stuck");` | killed |
| pl4-empty-throw | src/review/layers-payload.ts:287 | `if (files.length === 0) throw new Error(` → `if (false) throw new Error(` | timeout |
| cc1-len | src/review/coverage-complete.ts:201 | `quote.length < MIN_WAIVER_QUOTE_CHARS \|\| ` → `` | killed |
| ch2-plan-lock | src/review/chunks.ts:136 | `return withChunkStateLock(packageDir, () => cutChunkPlan(packageDir, projectRoot, radius, options));` → `return cutChunkPlan(packageDir, projectRoot, radius, options);` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

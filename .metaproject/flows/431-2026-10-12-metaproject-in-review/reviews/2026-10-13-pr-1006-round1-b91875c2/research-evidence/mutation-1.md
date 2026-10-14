# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts` (baseline exit 0, 10947 ms). Run in a scratch copy; the worktree was not written.

Killed 14, survived 6, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| m01 | src/review/layers.ts:229 | `    if (builtFrom !== prHead) {` → `    if (builtFrom !== prHead && builtFrom === null) {` | survived |
| m02 | src/review/layers.ts:386 | `  if (expected === null \|\| layers.graphCommit !== expected) {` → `  if (expected === null) {` | killed |
| m03 | src/review/layers.ts:234 | `    await writeSelfIgnoringDir(path.dirname(dataDir));` → `    await mkdir(path.dirname(dataDir), { recursive: true });` | killed |
| m04 | src/review/layers.ts:283 | `dryRun: !writeWiki,` → `dryRun: false,` | killed |
| m05 | src/review/layers-usage.ts:58 | `return log === undefined ? { ...UNKNOWN_LAYERS_USED } : countLayerUsage(log);` → `return countLayerUsage(log ?? "");` | killed |
| m06 | src/review/layers-payload.ts:234 | `if (sizeOf(deeper) <= maxBytes) block = deeper;` → `block = deeper;` | killed |
| m07 | src/review/layers-payload.ts:262 | `while (sizeOf(withTruncation()) > maxBytes) {` → `while (sizeOf(block) > maxBytes) {` | killed |
| m08 | src/review/chunks.ts:127 | `if (radius === undefined \|\| radius.dropped.length === 0) return null;` → `if (radius === undefined) return null;` | killed |
| m09 | src/review/chunks.ts:295 | `&& !state.derived.some((d) => d.retryOf?.includes(chunkId))` → `&& true` | survived |
| m10 | src/review/chunks.ts:320 | `if (!known.chunks.includes(outcome.chunk)) known.chunks.push(outcome.chunk);` → `known.chunks.push(outcome.chunk);` | survived |
| m11 | src/review/chunks.ts:322 | `if (rank(finding) < rank(known))` → `if (rank(finding) > rank(known))` | killed |
| m12 | src/review/chunks-estimate.ts:92 | `remaining.length > effective.maxPasses` → `remaining.length >= effective.maxPasses` | killed |
| m13 | src/review/chunks-estimate.ts:152 | `quote.trim() === ""` → `quote === ""` | killed |
| m14 | src/review/coverage-complete.ts:125 | `if (!covered.has(slice.id)) continue;` → `if (covered.size < 0) continue;` | killed |
| m15 | src/review/coverage-complete.ts:173 | `uncovered.every((entry) => waiver.files.includes(entry.file))` → `uncovered.some((entry) => waiver.files.includes(entry.file))` | killed |
| m16 | src/review/managed.ts:812 | `await recordCoverageWaiver(packageDir, options.waiveCoverage, options.now)` → `undefined` | survived |
| m17 | src/review/research.ts:52 | `await coverageGateErrors(packageDir, ledger)` → `([] as string[])` | killed |
| m18 | src/commands/review.ts:3869 | `waiver.value === undefined \|\| waiver.value.trim() === ""` → `waiver.value === undefined` | survived |
| m19 | src/lib/review-path-flags.ts:60 | `if (!placed.ok) return placed.message;` → `if (!placed.ok) continue;` | killed |
| m20 | src/tui/review-panel.ts:146 | `if (view.usage.unknown > 0) parts.push(`unknown ${view.usage.unknown}`);` → `parts.push(`unknown ${view.usage.unknown}`);` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

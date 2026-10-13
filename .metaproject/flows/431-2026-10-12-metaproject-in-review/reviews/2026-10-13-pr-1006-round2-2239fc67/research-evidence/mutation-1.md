# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts` (baseline exit 0, 13414 ms). Run in a scratch copy; the worktree was not written.

Killed 13, survived 12, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| m-1 | src/review/coverage-complete.ts:190 | `const MIN_WAIVER_QUOTE_LENGTH = 8;` → `const MIN_WAIVER_QUOTE_LENGTH = 3;` | survived |
| m-2 | src/tui/review-layers-actions.ts:27 | `[...SAFE_BUN_SPAWN_ARGS, process.argv[1] ?? "", "review", "layers", "refresh", "--package", packageDir, "--json"],` → `[...SAFE_BUN_SPAWN_ARGS, process.argv[1] ?? "", "review", "layers", "status", "--package", packageDir, "--json"],` | survived |
| m-3 | src/commands/review-layers.ts:67 | `if (!(await waitForLayersRefresh(packageDir))) {` → `if (false as boolean) {` | survived |
| m-4 | src/review/layers.ts:436 | `await writeFileAtomic(layersFilePath(input.packageDir), `${JSON.stringify(layers, null, 2)}\n`);` → `await Bun.write(layersFilePath(input.packageDir), `${JSON.stringify(layers, null, 2)}\n`);` | survived |
| m-5 | src/review/chunks.ts:338 | `const rank = (value: ChunkFinding): number => SEVERITY_RANK[String(value.severity ?? "").toLowerCase()] ?? 5;` → `const rank = (value: ChunkFinding): number => SEVERITY_RANK[String(value.severity ?? "").toLowerCase()] ?? -1;` | survived |
| m-6 | src/review/chunks.ts:337 | `if (!known.chunks.includes(outcome.chunk)) known.chunks.push(outcome.chunk);` → `known.chunks.push(outcome.chunk);` | survived |
| m-7 | src/review/chunks.ts:131 | `if (existing.droppedKey === undefined \|\| existing.droppedKey === droppedKey) return existing;` → `if (existing.droppedKey === droppedKey) return existing;` | survived |
| m-8 | src/review/layers.ts:439 | `{ timeoutMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS },` → `{ timeoutMs: LOCK_WAIT_MS, staleMs: 3_600_000_000 },` | survived |
| m-9 | src/review/layers.ts:181 | `return isLockHeld(layersLockPath(packageDir), LOCK_STALE_MS);` → `return isLockHeld(layersLockPath(packageDir), 0);` | survived |
| a01 | src/review/layers.ts:281 | `await deps.git(input.projectRoot, ["worktree", "prune"]);` → `void 0;` | survived |
| a02 | src/review/layers.ts:409 | `headSource = "manifest";` → `headSource = "input";` | killed |
| a03 | src/review/layers.ts:413 | `headSource = "checkout";` → `headSource = "manifest";` | killed |
| a04 | src/review/layers.ts:248 | `if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;` → `void 0;` | survived |
| a05 | src/review/layers.ts:303 | `await rm(staging, { recursive: true, force: true }).catch(() => {});` → `void 0;` | killed |
| a06 | src/review/layers.ts:305 | `await deps.git(input.projectRoot, ["worktree", "remove", "--force", "--end-of-options", worktree]);` → `void 0;` | killed |
| a07 | src/review/layers.ts:286 | `if (builtFrom !== prHead) {` → `if (false as boolean) {` | killed |
| a08 | src/review/layers.ts:463 | `if (expected === null \|\| layers.graphCommit !== expected) {` → `if (expected === null) {` | killed |
| a09 | src/commands/review-layers.ts:70 | `const head = options.prHead ?? (await manifestHead(packageDir)) ?? undefined;` → `const head = options.prHead ?? undefined;` | killed |
| a10 | src/commands/review-layers.ts:72 | `if (existing !== null && (head === undefined \|\| existing.prHead === head)) return existing;` → `if (existing !== null) return existing;` | killed |
| a11 | src/review/chunks.ts:133 | `if (Object.keys((await readChunkState(packageDir)).outcomes).length > 0) {` → `if (false as boolean) {` | killed |
| a12 | src/review/chunks.ts:321 | `major: 1, high: 1,` → `major: 1, high: 3,` | killed |
| a13 | src/tui/review-layers-actions.ts:28 | `{ cwd: projectRoot, timeout: REFRESH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },` → `{ cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 },` | survived |
| a14 | src/tui/reviews-inspector.ts:164 | `if (pendingReviews.has(newest.reviewId)) {` → `if (false as boolean) {` | killed |
| a15 | src/tui/reviews-inspector.ts:175 | `pendingReviews.delete(newest.reviewId);` → `void 0;` | killed |
| a16 | src/memory/service.ts:121 | `const indexDir = input.indexDir ?? path.join(dataRoot(input.cwd), "index");` → `const indexDir = path.join(dataRoot(input.cwd), "index");` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

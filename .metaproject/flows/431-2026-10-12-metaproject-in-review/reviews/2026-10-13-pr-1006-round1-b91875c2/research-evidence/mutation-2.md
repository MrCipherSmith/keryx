# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk` (baseline exit 0, 20878 ms). Run in a scratch copy; the worktree was not written.

Killed 18, survived 8, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| f01 | src/review/layers.ts:408 | `prHead = await manifestHead(input.packageDir);` → `prHead = null;` | killed |
| f02 | src/review/layers.ts:454 | `if (await layersRefreshInFlight(packageDir)) {` → `if (false as boolean) {` | killed |
| f03 | src/review/layers.ts:254 | `if (hadPrevious) await rename(previous, finalDir).catch(() => {});` → `void 0;` | survived |
| f04 | src/review/layers.ts:142 | `return createMemoryService().index({ cwd, embeddings: false, indexDir });` → `return createMemoryService().index({ cwd, embeddings: false });` | killed |
| f05 | src/review/layers.ts:283 | `"--end-of-options", worktree, prHead]);` → `"--end-of-options", worktree, "HEAD"]);` | killed |
| f06 | src/review/layers.ts:199 | `return typeof head === "string" && /^[0-9a-f]{7,64}$/i.test(head) ? head : null;` → `return typeof head === "string" ? head : null;` | survived |
| f07 | src/review/layers.ts:402 | `if (input.prHead !== undefined) assertGitRevision(input.prHead);` → `void 0;` | survived |
| f08 | src/review/layers.ts:207 | `return parsed !== null && parsed.version === LAYERS_VERSION ? parsed : null;` → `return parsed;` | survived |
| f09 | src/review/chunks.ts:321 | `{ blocker: 0, critical: 0,` → `{ blocker: 5, critical: 0,` | killed |
| f10 | src/review/chunks.ts:273 | `return withFileLock(path.join(packageDir, CHUNK_STATE_LOCK), () => recordChunkLocked(packageDir, chunkId, result), { timeoutMs: 30_000 });` → `return recordChunkLocked(packageDir, chunkId, result);` | killed |
| f11 | src/review/chunks.ts:286 | `const finished = status === "DONE" \|\| status === "DONE_WITH_CONCERNS";` → `const finished = status === "DONE";` | survived |
| f12 | src/review/chunks.ts:310 | `const alreadySplit = state.derived.some((d) => d.retryOf?.includes(chunkId));` → `const alreadySplit = false;` | survived |
| f13 | src/review/chunks.ts:131 | `if (existing.droppedKey === undefined \|\| existing.droppedKey === droppedKey) return existing;` → `return existing;` | killed |
| f14 | src/review/chunks-estimate.ts:161 | `const answered = record?.estimate.planKey === estimate.planKey ? record.answer : undefined;` → `const answered = record?.answer;` | survived |
| f15 | src/review/coverage-complete.ts:190 | `const MIN_WAIVER_QUOTE_LENGTH = 8;` → `const MIN_WAIVER_QUOTE_LENGTH = 0;` | killed |
| f16 | src/review/coverage-complete.ts:198 | `.replace(/-{0,2}waive[- ]?coverage/gi, "")` → `.replace(/zzzz/gi, "")` | killed |
| f17 | src/review/managed.ts:819 | `if (coverageWaiver !== undefined && researchBefore !== undefined) await writeFileAtomic(researchPath, researchBefore);` → `void 0;` | killed |
| f18 | src/lib/command-risk.ts:626 | `\|\| touchesSchedulerControl(command) \|\| touchesCoverageWaiver(command);` → `\|\| touchesSchedulerControl(command);` | killed |
| f19 | src/review/layers-payload.ts:188 | `return `'${value.replace(/'/g, `'\\''`)}'`;` → `return `'${value}'`;` | killed |
| f20 | src/review/layers-payload.ts:226 | `if (unsafe !== undefined) throw new Error(` → `if (unsafe === "never") throw new Error(` | killed |
| f21 | src/review/layers-payload.ts:227 | `const files = allFiles.slice(0, MAX_BLOCK_FILES);` → `const files = allFiles;` | killed |
| f22 | src/review/layers-payload.ts:199 | `return `keryx gdgraph affected ${shellQuote(first)} --depth 2` → `return `keryx gdgraph affected ${first} --depth 2` | killed |
| f23 | src/review/layers-usage.ts:57 | `return log === undefined \|\| log.trim() === "" ?` → `return log === undefined ?` | killed |
| f24 | src/review/layers-usage.ts:72 | `if (!(await stat(real)).isFile()) return undefined;` → `void 0;` | survived |
| f25 | src/review/layers-usage.ts:71 | `if (realInside.startsWith("..") \|\| path.isAbsolute(realInside)) return undefined;` → `void 0;` | killed |
| f26 | src/commands/review-layers.ts:50 | `const placed = placeReviewPath(command, "--package", raw, { projectRoot: resolveProjectRoot(cwd), cwd });` → `const placed = { ok: true as const, path: raw };` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

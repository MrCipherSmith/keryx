# Mutation pass

Command: `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` (baseline exit 0, 24173 ms). Run in a scratch copy; the worktree was not written.

Killed 8, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| r2-block-force-not-passed | src/commands/review-layers.ts:137 | `{ projectRoot, force: rest.includes("--force") }` → `{ projectRoot }` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r2-ensure-force-dropped | src/commands/review-layers.ts:83 | `...(options.force === true ? { force: true } : {}),` → `` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r2-tui-force-dropped | src/tui/review-layers-actions.ts:25 | `"--package", packageDir, "--force", "--json"]` → `"--package", packageDir, "--json"]` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r2-maxbuffer-misreported-as-timeout | src/tui/review-layers-actions.ts:55 | `const timedOut = Date.now() - startedAt >= timeoutMs - 100;` → `const timedOut = true;` | survived | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 0 |
| r2-signal-bound-removed | src/review/layers.ts:369 | `Promise.race([settled, bound])` → `settled` | survived | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 0 |
| r2-unregister-before-cleanup | src/review/layers.ts:416 | `try {       await cleanup();     } finally {       unregister();     }` → `unregister();     await cleanup();` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r2-layers-write-seam-bypassed | src/review/layers.ts:615 | `await deps.writeLayers(layersFilePath` → `await writeFileAtomic(layersFilePath` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r2-failed-retry-hint-dropped-from-error | src/review/layers.ts:643 | `${layers.graph.error ? ': ${layers.graph.error}' : ""}${retry}'` → `${layers.graph.error ? ': ${layers.graph.error}' : ""}'` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r2-view-failed-hint-dropped | src/review/layers-view.ts:37 | `${graph.status === "failed" ? " (not retried automatically for a few minutes at the same head; refresh --force retries now)" : ""}` → `` | survived | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 0 |
| r2-unavailable-text-format-reverted | src/review/layers-payload.ts:360 | `lines.push('  ${gap.section}: unavailable (${gap.reason})')` → `lines.push('  unavailable ${gap.section}: ${gap.reason}')` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |
| r2-readpage-seam-ignored | src/review/layers-payload.ts:181 | `content = await readPage(page.absolutePath);` → `content = await readFile(page.absolutePath, "utf8");` | killed | `bun test src/review/layers src/commands/review-layers.test.ts src/tui/reviews-inspector.test.ts src/tui/review-layers-child.test.ts` | 1 |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

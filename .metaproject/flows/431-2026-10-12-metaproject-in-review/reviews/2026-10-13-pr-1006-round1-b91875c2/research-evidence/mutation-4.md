# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk` (baseline exit 0, 13164 ms). Run in a scratch copy; the worktree was not written.

Killed 8, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| f03 | src/review/layers.ts:254 | `if (hadPrevious) await rename(previous, finalDir).catch(() => {});` → `void 0;` | killed |
| f06 | src/review/layers.ts:199 | `return typeof head === "string" && /^[0-9a-f]{7,64}$/i.test(head) ? head : null;` → `return typeof head === "string" ? head : null;` | killed |
| f07 | src/review/layers.ts:402 | `if (input.prHead !== undefined) assertGitRevision(input.prHead);` → `void 0;` | killed |
| f08 | src/review/layers.ts:207 | `return parsed !== null && parsed.version === LAYERS_VERSION ? parsed : null;` → `return parsed;` | killed |
| f11 | src/review/chunks.ts:286 | `const finished = status === "DONE" \|\| status === "DONE_WITH_CONCERNS";` → `const finished = status === "DONE";` | killed |
| f12 | src/review/chunks.ts:310 | `const alreadySplit = state.derived.some((d) => d.retryOf?.includes(chunkId));` → `const alreadySplit = false;` | killed |
| f14 | src/review/chunks-estimate.ts:161 | `const answered = record?.estimate.planKey === estimate.planKey ? record.answer : undefined;` → `const answered = record?.answer;` | killed |
| f24 | src/review/layers-usage.ts:72 | `if (!(await stat(real)).isFile()) return undefined;` → `void 0;` | killed |

No survivor.

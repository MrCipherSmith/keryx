# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts src/lib/command-risk src/lib/trust-routine-command.test.ts src/commands/review-chunks.test.ts src/flow/review-gate-coverage.test.ts` (baseline exit 0, 19829 ms). Run in a scratch copy; the worktree was not written.

Killed 7, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| r3-03-args-text | src/review/layers-usage.ts:62 | `layersOfCommand(call, found);   return LAYER_NAMES` → `layersOfCommand(call, found);   if (/keryx\s+wiki/.test(call)) found.add("wiki");   return LAYER_NAMES` | killed |
| r3-03-first-segment | src/review/layers-usage.ts:37 | `for (const segment of splitSegments(command)) {` → `for (const segment of splitSegments(command).slice(0, 1)) {` | killed |
| r3-03-mcp-args | src/review/layers-usage.ts:91 | `for (const key of ["name", "tool"])` → `for (const key of ["name", "tool", "arguments"])` | survived |
| r3-05-completeness | src/flow/review-gate.ts:448 | ` && (await packageRecordsCoverage(packageDir));` → `;` | killed |
| r3-ly-fsmonitor | src/review/layers.ts:369 | `"-c", "core.fsmonitor=false", ` → `` | killed |
| r3-ly-peel | src/review/layers.ts:226 | ``${rev}^{commit}`` → `rev` | killed |
| r3-ly-lock-stale-opt-off | src/review/layers.ts:572 | `{ timeoutMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS }` → `{ timeoutMs: LOCK_WAIT_MS }` | killed |
| r3-rl-maxbytes-floor | src/commands/review-layers.ts:133 | `maxBytes < 256` → `maxBytes < 255` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

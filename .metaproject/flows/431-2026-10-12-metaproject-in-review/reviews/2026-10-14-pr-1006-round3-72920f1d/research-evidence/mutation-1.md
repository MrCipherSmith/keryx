# Mutation pass

Command: `bun test src/review src/commands/review-layers.test.ts src/commands/review-ledger.test.ts src/commands/review-slice-paths.test.ts src/gdskills/reviewer-layer-block.test.ts src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts` (baseline exit 0, 17214 ms). Run in a scratch copy; the worktree was not written.

Killed 8, survived 4, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| r3-ly-fsmonitor | src/review/layers.ts:369 | `"-c", "core.fsmonitor=false", ` → `` | survived |
| r3-ly-prune-always | src/review/layers.ts:371 | `if (added === null) {       // Only a failed add prunes` → `if (true) {       // Only a failed add prunes` | killed |
| r3-ly-peel | src/review/layers.ts:226 | ``${rev}^{commit}`` → `rev` | survived |
| r3-ly-lock-stale-opt-off | src/review/layers.ts:572 | `{ timeoutMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS }` → `{ timeoutMs: LOCK_WAIT_MS }` | survived |
| r3-ly-lock-wait | src/review/layers.ts:572 | `{ timeoutMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS }` → `{ timeoutMs: 0, staleMs: LOCK_STALE_MS }` | killed |
| r3-ly-publish-no-restore | src/review/layers.ts:300 | `if (hadPrevious) await rename(previous, finalDir).catch(() => {});     throw error;` → `throw error;` | killed |
| r3-ly-signal-lock-keep | src/review/layers.ts:363 | `.then(() => rm(layersLockPath(input.packageDir), { recursive: true, force: true }))` → `.then(() => {})` | killed |
| r3-ly-wait-deadline | src/review/layers.ts:196 | `if (Date.now() >= deadline) return false;` → `if (false) return false;` | killed |
| r3-ck-files-cap-off | src/review/chunks.ts:103 | `current.files.length >= maxFiles \|\|` → `false \|\|` | killed |
| r3-ck-bytes-cap-off | src/review/chunks.ts:103 | `(current.files.length > 0 && current.bytes + size > maxBytes)` → `false` | killed |
| r3-rl-maxbytes-floor | src/commands/review-layers.ts:133 | `maxBytes < 256` → `maxBytes < 0` | survived |
| r3-rl-current-head-off | src/commands/review-layers.ts:76 | `if (existing !== null && (await layersCurrent(packageDir, existing, head))) return existing;` → `if (existing !== null) return existing;` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

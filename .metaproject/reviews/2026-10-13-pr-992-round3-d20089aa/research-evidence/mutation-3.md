# Mutation pass

Command: `bun test src/lib/test-preload.test.ts src/commands/agent-question-axis.test.ts` (baseline exit 0, 244 ms). Run in a scratch copy; the worktree was not written.

Killed 2, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M20-second-preload-dropped | bunfig.toml:11 | `preload = ["./src/lib/test-preload.ts", "./src/lib/test-preload-hooks.ts"]` → `preload = ["./src/lib/test-preload.ts"]` | killed |
| M21-preload-reset-dropped | src/lib/test-preload-hooks.ts:12 | `beforeEach(() => resetOperatorDenials());` → `beforeEach(() => {});` | killed |

No survivor.

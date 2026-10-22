# Mutation pass

Command: `bun test src/tui/tui-shell src/tui/connect` (baseline exit 0, 18503 ms). Run in a scratch copy; the worktree was not written.

Killed 1, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| w2-M9 | src/tui/tui-shell.ts:3829 | `saveApiKey(envKey, kr.value, deps.configDir); // persist (0600)` → `void 0; // persist (0600)` | killed | `bun test src/tui/tui-shell src/tui/connect` | 1 |

No survivor.

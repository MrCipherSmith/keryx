# Mutation pass

Command: `bun test src/tui/connect src/tui/modal-host` (baseline exit 0, 12846 ms). Run in a scratch copy; the worktree was not written.

Killed 1, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| w2-M10 | src/tui/modal-host.ts:648 | `if (key.name === "right" \|\| (onStrip && key.name === "tab")) {` → `if (key.name === "right") {` | killed | `bun test src/tui/connect src/tui/modal-host` | 1 |

No survivor.

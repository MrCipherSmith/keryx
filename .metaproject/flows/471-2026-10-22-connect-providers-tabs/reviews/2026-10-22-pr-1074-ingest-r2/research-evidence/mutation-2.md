# Mutation pass

Command: `bun test src/tui/connect src/tui/modal-host` (baseline exit 0, 13416 ms). Run in a scratch copy; the worktree was not written.

Killed 0, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| w2-M10 | src/tui/modal-host.ts:648 | `if (key.name === "right" \|\| (onStrip && key.name === "tab")) {` → `if (key.name === "right") {` | survived | `bun test src/tui/connect src/tui/modal-host` | 0 |

A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed.

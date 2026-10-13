# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts` (baseline exit 0, 642 ms). Run in a scratch copy; the worktree was not written.

Killed 1, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| B17-short-flag-prefix | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^-[^=]+=-./s.test(w)` | killed |

No survivor.

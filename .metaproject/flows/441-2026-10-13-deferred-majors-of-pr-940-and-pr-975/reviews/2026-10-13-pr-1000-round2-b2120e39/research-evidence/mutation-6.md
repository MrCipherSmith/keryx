# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts` (baseline exit 0, 138 ms). Run in a scratch copy; the worktree was not written.

Killed 1, survived 3, timeout 1, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| exp-backslash | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$*?[\]{}`]/` | killed |
| exp-backtick | src/lib/trust-routine-command.ts:223 | `/[$\\*?[\]{}`]/` → `/[$\\*?[\]{}]/` | survived |
| rk-review-only | src/lib/trust-routine-command.ts:261 | `args[0] === "review" && sub !== undefined` → `sub !== undefined` | survived |
| seg-assign | src/lib/trust-routine-command.ts:268 | `stripAssignments(words).length !== words.length` → `false` | survived |
| bunfig-isfile | src/lib/trust-routine-command.ts:168 | `if (!stat.isFile() \|\| stat.size > MAX_BUNFIG_BYTES) return { kind: "unreadable" };` → `if (stat.size > MAX_BUNFIG_BYTES) return { kind: "unreadable" };` | timeout |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

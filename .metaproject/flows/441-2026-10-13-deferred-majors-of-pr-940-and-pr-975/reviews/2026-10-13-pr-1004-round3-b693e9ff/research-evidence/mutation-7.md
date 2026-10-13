# Mutation pass

Command: `bun test src/review/replay.test.ts` (baseline exit 0, 3356 ms). Run in a scratch copy; the worktree was not written.

Killed 1, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| S07-maxbuffer-tiny | src/review/replay.ts:134 | `maxBuffer: 64 * 1024 * 1024` → `maxBuffer: 1000` | killed |

No survivor.

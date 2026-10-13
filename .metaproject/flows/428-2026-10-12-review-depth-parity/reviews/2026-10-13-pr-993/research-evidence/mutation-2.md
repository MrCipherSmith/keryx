# Mutation pass

Command: `bun test src/review/mutate.test.ts` (baseline exit 0, 3376 ms). Run in a scratch copy; the worktree was not written.

Killed 4, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M4 | src/review/mutate.ts:166 | `${m.exitCode ?? "-"}` → `${m.exitCode ?? 0}` | killed |
| M5 | src/review/mutate.ts:176 | `\| Result \| Test command \| Exit \|` → `\| Result \|` | killed |
| M6 | src/review/mutate.ts:166 | `${cell(m.command ?? record.command)}` → `${m.command ?? record.command}` | killed |
| M7 | src/review/mutate.ts:166 | `cell(m.command ?? record.command)` → `cell(m.command as string)` | killed |

No survivor.

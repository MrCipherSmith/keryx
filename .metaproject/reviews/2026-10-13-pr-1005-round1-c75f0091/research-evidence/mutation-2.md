# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/commands/review-revision-operand.test.ts` (baseline exit 0, 15954 ms). Run in a scratch copy; the worktree was not written.

Killed 0, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| R8b-condition-inverted-needle-intact | src/commands/review-jev-docs.ts:472 | `...(ref === undefined ? [] : ["--end-of-options", assertGitRevision(ref)])];` → `...(ref !== undefined ? [] : ["--end-of-options", assertGitRevision(ref)])];` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

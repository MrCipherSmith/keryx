# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/commands/review-revision-operand.test.ts` (baseline exit 0, 15067 ms). Run in a scratch copy; the worktree was not written.

Killed 9, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| G1 | src/lib/trust-routine-command.ts:113 | `hasExecFlag([w.slice(eq + 1)])` → `(w.slice(eq + 1) === "-c" \|\| EXEC_FLAGS.some((f) => w.slice(eq + 1) === f \|\| w.slice(eq + 1).startsWith(`${f}=`)))` | survived |
| G2-no-recursion | src/lib/trust-routine-command.ts:113 | `hasExecFlag([w.slice(eq + 1)])` → `false` | killed |
| G6 | src/lib/trust-routine-command.ts:119 | `/^--[^=]+=-/` → `/^--(ref\|base)=-/` | survived |
| G7-dashvalue-off | src/lib/trust-routine-command.ts:299 | `if (args[0] === "review" && hasDashValue(args)) return false;` → `if (false) return false;` | killed |
| G8-dashvalue-never | src/lib/trust-routine-command.ts:119 | `/^--[^=]+=-/` → `/^--[^=]+=-x-never/` | killed |
| R1-assert-off | src/lib/git-revision.ts:7 | `if (ref.startsWith("-"))` → `if (false)` | killed |
| R2-gitdiff-no-eoo | src/commands/review.ts:3598 | ``-U${contextLines}`, ...(ref === undefined ? [] : ["--end-of-options", assertGitRevision(ref)])];` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])];` | killed |
| R3-namesonly-no-eoo | src/commands/review.ts:3545 | `"--diff-filter=d", ...(ref === undefined ? [] : ["--end-of-options", assertGitRevision(ref)])];` → `"--diff-filter=d", ...(ref === undefined ? [] : [ref])];` | killed |
| R4-mergebase-no-eoo | src/commands/review.ts:3674 | `gitOutput(["merge-base", "--end-of-options", "HEAD", assertGitRevision(ref)])` → `gitOutput(["merge-base", "HEAD", assertGitRevision(ref)])` | killed |
| R8 | src/commands/review-jev-docs.ts:472 | `...(ref === undefined ? [] : ["--end-of-options", assertGitRevision(ref)])];` → `...(ref !== undefined ? [] : ["--end-of-options", assertGitRevision(ref ?? "HEAD")])];` | killed |
| R9 | src/commands/review-jev-docs.ts:472 | `...(ref === undefined ? [] : ["--end-of-options", assertGitRevision(ref)])];` → `...(ref === undefined ? [] : [ref])]; // "--end-of-options", assertGitRevision(ref)` | survived |
| R10-jev-select-no-assert | src/commands/review-jev-select.ts:121 | `["--end-of-options", assertGitRevision(ref)]` → `["--end-of-options", ref]` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

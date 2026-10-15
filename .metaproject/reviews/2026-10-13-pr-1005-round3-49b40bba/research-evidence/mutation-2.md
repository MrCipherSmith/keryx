# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/commands/review-revision-operand.test.ts src/sync/provenance.test.ts src/sync/diff.test.ts src/gdgraph/staleness.test.ts` (baseline exit 0, 28437 ms). Run in a scratch copy; the worktree was not written.

Killed 21, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| C13-sync-guard | src/sync/diff.ts:79 | `if (base.startsWith("-")) return null;` → `` | killed |
| R1-assert-off | src/lib/git-revision.ts:7 | `if (ref.startsWith("-")) throw` → `if (false) throw` | killed |
| R2-assert-only-double-dash | src/lib/git-revision.ts:7 | `ref.startsWith("-")) throw` → `ref.startsWith("--")) throw` | killed |
| R3-operand-no-eoo | src/lib/git-revision.ts:23 | `return ["--end-of-options", assertGitRevision(ref)];` → `return [assertGitRevision(ref)];` | killed |
| R4-no-writing-output-eq | src/lib/git-revision.ts:13 | ` \|\| a.startsWith("--output=")` → `` | killed |
| R5-no-writing-output-bare | src/lib/git-revision.ts:13 | `a === "--output" \|\| ` → `` | killed |
| R6-no-writing-ext-diff | src/lib/git-revision.ts:13 | ` \|\| a === "--ext-diff"` → `` | killed |
| S1-ctx-diff-guard-off | src/commands/ctx.ts:203 | `  assertNoWritingDiffOption(args);` → `` | killed |
| S2-flow-base-unchecked | src/commands/flow.ts:401 | `return value === undefined ? undefined : assertGitRevision(value);` → `return value;` | killed |
| S3-checkac-mergebase-bare | src/commands/flow-check-ac.ts:168 | `["git", "merge-base", "HEAD", ...revisionOperand(refName)]` → `["git", "merge-base", "HEAD", refName]` | killed |
| S4-checkac-diff-bare | src/commands/flow-check-ac.ts:171 | `"-U20", ...revisionOperand(ref)]` → `"-U20", ref]` | killed |
| S7-health-bare | src/health/run.ts:622 | `["git", "diff", "--name-only", ...revisionOperand(ref)]` → `["git", "diff", "--name-only", ref]` | killed |
| S8-testing-bare | src/testing/service.ts:760 | `["git", "diff", "--name-only", ...revisionOperand(since)]` → `["git", "diff", "--name-only", since]` | killed |
| S12-wiki-service-guard-off | src/wiki/service.ts:1622 | `if (base.startsWith("-")) return Promise.resolve(null);` → `` | survived |
| S14-review-changedfiles-bare | src/commands/review.ts:3545 | `"--diff-filter=d", ...(ref === undefined ? [] : revisionOperand(ref))]` → `"--diff-filter=d", ...(ref === undefined ? [] : [ref])]` | killed |
| S15-review-gitdiff-bare | src/commands/review.ts:3598 | ``-U${contextLines}`, ...(ref === undefined ? [] : revisionOperand(ref))]` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])]` | killed |
| S16-review-mergebase-bare | src/commands/review.ts:3674 | `["merge-base", "HEAD", ...revisionOperand(ref)]` → `["merge-base", "HEAD", ref]` | killed |
| S17-jev-select-bare | src/commands/review-jev-select.ts:121 | ``-U${contextLines}`, ...(ref === undefined ? [] : revisionOperand(ref))]` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])]` | killed |
| N24-staleness-bare | src/gdgraph/staleness.ts:243 | `...revisionOperand(fromCommit), toCommit]` → `fromCommit, toCommit]` | killed |
| N25-staleness-catch-rethrow | src/gdgraph/staleness.ts:245 | `this check never throws.     return [];` → `this check never throws.     throw new Error("x");` | survived |
| N26-sync-diff-guard-off | src/sync/diff.ts:79 | `if (base.startsWith("-")) return null;` → `` | killed |
| N27-review-ctx-diff-guard | src/commands/ctx.ts:203 | `  assertNoWritingDiffOption(args);` → `` | killed |
| N28-writing-ext-diff | src/lib/git-revision.ts:13 | ` \|\| a === "--ext-diff"` → `` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

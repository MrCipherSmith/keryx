# Mutation pass

Command: `bun test src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` (baseline exit 0, 14728 ms). Run in a scratch copy; the worktree was not written.

Bail: applied (mutants ran with --bail; baseline in full).

Cost: provenance 3815 ms, copy 117601 ms, mutants 132845 ms, load 9.8/16.5/15.9.

started 2026-11-24T11:16:15.553Z, head 5957d12494d3, treeHash ae460bbd3b6d.

Killed 0, survived 7, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| TP2-M1 | src/commands/review-advance.ts:27 | `(v.base === undefined) !== (v.head === undefined) \|\|` → `` | survived | `bun test --bail src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` | 0 |
| TP2-M2 | src/commands/review-advance.ts:27 | `(v.id !== undefined && !uuid.test(v.id)) \|\|` → `` | survived | `bun test --bail src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` | 0 |
| TP2-M3 | src/commands/operator-confirm-review.ts:261 | `        findPublished: seams.findPublished ?? githubFindPublished, ` → `` | survived | `bun test --bail src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` | 0 |
| TP2-M4 | src/commands/operator-confirm-review.ts:259 | `        publication: await sessionPublication(prepared.dir, undefined, () => undefined), ` → `` | survived | `bun test --bail src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` | 0 |
| TP2-M5 | src/commands/review.ts:5177 | `  if (register !== undefined) {     const recorded` → `  if (false) {     const recorded` | survived | `bun test --bail src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` | 0 |
| TP2-M6 | src/commands/review.ts:5078 | `    readiness,     publication, ` → `    readiness, ` | survived | `bun test --bail src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` | 0 |
| TP2-M7 | src/commands/review.ts:5081 | `    findPublished: seams?.findPublished ?? githubFindPublished, ` → `` | survived | `bun test --bail src/review/publish.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/review-advance.test.ts` | 0 |

A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed.

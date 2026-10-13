# Mutation pass

Command: `bun test src/review/replay.test.ts` (baseline exit 0, 1171 ms). Run in a scratch copy; the worktree was not written.

Killed 4, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M11-table-decision-unescaped | src/review/replay.ts:178 | `${cell(decisionFor(row, decisions))}` → `${decisionFor(row, decisions)}` | killed |
| S07-maxbuffer-tiny | src/review/replay.ts:134 | `maxBuffer: 64 * 1024 * 1024` → `maxBuffer: 1000` | survived |
| M20-env-scrub-off | src/review/replay.ts:129 | `env: withoutGitDiscoveryOverrides(process.env)` → `env: process.env` | killed |
| M21-scrub-drops-git-dir | src/lib/git-env.ts:16 | `  "GIT_DIR", ` → `` | killed |
| M22-scrub-drops-index-file | src/lib/git-env.ts:18 | `  "GIT_INDEX_FILE", ` → `` | killed |
| M23-scrub-drops-work-tree | src/lib/git-env.ts:17 | `  "GIT_WORK_TREE", ` → `` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.

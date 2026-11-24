# Mutation pass

Command: `bun --cwd apps/desktop test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts` (baseline exit 1, 547 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 457 ms, copy 26606 ms, load 9.0/17.8/19.0.

started 2026-11-24T09:13:55.187Z, head 3ad918b66a99, treeHash aa558232587e.

Baseline failed (exit 1); no mutant ran. cwd: `/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/.metaproject/data/review/mutate-scratch/keryx-mutate-hMHydb/tree`. Last output:

```
src/session/LineComments.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/session/Transcript.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/session/taskStream.test.ts:

# Unhandled error between tests
-------------------------------
-------------------------------


src/session/CommandCard.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/metaproject/MetaprojectTree.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/metaproject/MetaprojectView.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/platform/metaproject.test.ts:

# Unhandled error between tests
-------------------------------
-------------------------------


# Unhandled error between tests
-------------------------------
-------------------------------


 430 pass
 48 fail
 47 errors
 7987 expect() calls
Ran 478 tests across 93 files. [365.00ms]
error: script "test" exited with code 1
```

Killed 0, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|

No survivor.

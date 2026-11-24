# Mutation pass

Command: `sh -c 'cd apps/desktop && bun test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts'` (baseline exit 1, 243 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 485 ms, copy 23600 ms, load 12.1/17.5/18.8.

started 2026-11-24T09:14:47.124Z, head 3ad918b66a99, treeHash aa558232587e.

Baseline failed (exit 1); no mutant ran. cwd: `/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/.metaproject/data/review/mutate-scratch/keryx-mutate-geFsnx/tree`. Last output:

```
bun test v1.4.4 (38afee6c8)

src/metaproject/MetaprojectTree.dom.test.tsx:

# Unhandled error between tests
-------------------------------
error: Cannot find module '@happy-dom/global-registrator' from '/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/.metaproject/data/review/mutate-scratch/keryx-mutate-geFsnx/tree/apps/desktop/src/test/dom.ts'
-------------------------------


src/metaproject/MetaprojectView.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


 16 pass
 2 fail
 2 errors
 66 expect() calls
Ran 18 tests across 3 files. [22.00ms]
```

Killed 0, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|

No survivor.

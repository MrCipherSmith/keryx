# Mutation pass

Command: `bun test src/metaproject/MetaprojectTree.dom.test.tsx src/metaproject/MetaprojectView.dom.test.tsx src/platform/metaproject.test.ts` (baseline exit 1, 430 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 404 ms, copy 60497 ms, load 17.3/21.7/20.4.

started 2026-11-24T09:12:36.951Z, head 3ad918b66a99, treeHash aa558232587e.

Baseline failed (exit 1); no mutant ran. cwd: `/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/.metaproject/data/review/mutate-scratch/keryx-mutate-dqO83D/tree`. Last output:

```
bun test v1.4.4 (38afee6c8)
The following filters did not match any test files in --cwd="/Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/.metaproject/data/review/mutate-scratch/keryx-mutate-dqO83D/tree":
 src/metaproject/MetaprojectTree.dom.test.tsx src/metaproject/MetaprojectView.dom.test.tsx src/platform/metaproject.test.ts
7281 files were searched [319.00ms]

note: Tests need ".test", "_test_", ".spec" or "_spec_" in the filename (ex: "MyApp.test.ts")
note: To treat the "src/metaproject/MetaprojectTree.dom.test.tsx" filter as a path, run "bun test ./src/metaproject/MetaprojectTree.dom.test.tsx"
```

Killed 0, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|

No survivor.

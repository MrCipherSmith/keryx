# Mutation pass

Command: `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` (baseline exit 1, 409 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 2215 ms, copy 58500 ms, load 13.0/13.0/12.1.

started 2026-11-24T10:14:24.101Z, head 20e4281a2ac0, treeHash e3b0c44298fc.

Baseline failed (exit 1); no mutant ran. cwd: `/var/folders/0h/3tmtr97124j3ms95y3_p2pv40000gp/T/keryx-mutate-1RLUV5/tree`. Last output:

```
      at <anonymous> (/private/var/folders/0h/3tmtr97124j3ms95y3_p2pv40000gp/T/keryx-mutate-1RLUV5/tree/apps/desktop/src/shell/SettingsView.dom.test.tsx:7:3)
(fail) Settings tabs, drafts, closure and independent mode palettes work through the project UI [75.60ms]

src/shell/UpdateBanner.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module 'react/jsx-runtime' from '/private/var/folders/0h/3tmtr97124j3ms95y3_p2pv40000gp/T/keryx-mutate-1RLUV5/tree/apps/desktop/src/shell/UpdateBanner.tsx'
-------------------------------


src/shell/ProjectNavigation.dom.test.tsx:

# Unhandled error between tests
-------------------------------
error: Cannot find module 'react/jsx-runtime' from '/private/var/folders/0h/3tmtr97124j3ms95y3_p2pv40000gp/T/keryx-mutate-1RLUV5/tree/apps/desktop/src/shell/ProjectNavigation.dom.test.tsx'
-------------------------------


src/review/ReviewDetail.dom.test.tsx:

# Unhandled error between tests
-------------------------------
error: Cannot find module '@happy-dom/global-registrator' from '/private/var/folders/0h/3tmtr97124j3ms95y3_p2pv40000gp/T/keryx-mutate-1RLUV5/tree/apps/desktop/src/test/dom.ts'
-------------------------------


src/review/ReviewBoard.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/review/ReviewLaunchDialog.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/reviews/ReviewPanel.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


src/reviews/ReviewsView.dom.test.tsx:

# Unhandled error between tests
-------------------------------
-------------------------------


 41 pass
 8 fail
 7 errors
 188 expect() calls
Ran 49 tests across 17 files. [131.00ms]
```

Killed 0, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|

No survivor.

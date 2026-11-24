# Mutation pass

Command: `sh -c 'cd apps/desktop && bun test src/review src/reviews src/shell src/platform src/test'` (baseline exit 1, 394 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 1282 ms, copy 35445 ms, load 22.5/16.9/13.8.

started 2026-11-24T10:16:13.313Z, head 20e4281a2ac0, treeHash e3b0c44298fc.

Baseline failed (exit 1); no mutant ran. cwd: `/private/tmp/claude-502/-Users-tsaitler-aleksandr-work-sandbox-keryx--claude-worktrees-desktop-review-v2-stage2-dce093/c5d83144-e435-4811-952e-d8fae0f8a370/scratchpad/head-20e4281/.metaproject/data/review/mutate-scratch/keryx-mutate-pVuqde/tree`. Last output:

```
      at <anonymous> (/private/tmp/claude-502/-Users-tsaitler-aleksandr-work-sandbox-keryx--claude-worktrees-desktop-review-v2-stage2-dce093/c5d83144-e435-4811-952e-d8fae0f8a370/scratchpad/head-20e4281/.metaproject/data/review/mutate-scratch/keryx-mutate-pVuqde/tree/apps/desktop/src/shell/SettingsView.dom.test.tsx:7:3)
(fail) Settings tabs, drafts, closure and independent mode palettes work through the project UI [17.72ms]

src/shell/UpdateBanner.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module 'react/jsx-runtime' from '/private/tmp/claude-502/-Users-tsaitler-aleksandr-work-sandbox-keryx--claude-worktrees-desktop-review-v2-stage2-dce093/c5d83144-e435-4811-952e-d8fae0f8a370/scratchpad/head-20e4281/.metaproject/data/review/mutate-scratch/keryx-mutate-pVuqde/tree/apps/desktop/src/shell/UpdateBanner.tsx'
-------------------------------


src/shell/ProjectNavigation.dom.test.tsx:

# Unhandled error between tests
-------------------------------
error: Cannot find module 'react/jsx-runtime' from '/private/tmp/claude-502/-Users-tsaitler-aleksandr-work-sandbox-keryx--claude-worktrees-desktop-review-v2-stage2-dce093/c5d83144-e435-4811-952e-d8fae0f8a370/scratchpad/head-20e4281/.metaproject/data/review/mutate-scratch/keryx-mutate-pVuqde/tree/apps/desktop/src/shell/ProjectNavigation.dom.test.tsx'
-------------------------------


src/review/ReviewDetail.dom.test.tsx:

# Unhandled error between tests
-------------------------------
error: Cannot find module '@happy-dom/global-registrator' from '/private/tmp/claude-502/-Users-tsaitler-aleksandr-work-sandbox-keryx--claude-worktrees-desktop-review-v2-stage2-dce093/c5d83144-e435-4811-952e-d8fae0f8a370/scratchpad/head-20e4281/.metaproject/data/review/mutate-scratch/keryx-mutate-pVuqde/tree/apps/desktop/src/test/dom.ts'
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
Ran 49 tests across 17 files. [92.00ms]
```

Killed 0, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|

No survivor.

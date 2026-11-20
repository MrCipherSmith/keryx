# Context
- Spec (not yet on main; PR #1259, branch origin/docs/desktop-improvements-spec), copied for workers to
  /private/tmp/claude-502/-Users-Goodea-goodea-keryx--claude-worktrees-laughing-mclean-7b4e89/432a85a7-f04d-4ef5-9127-2e753dab775b/scratchpad/spec/
  (specification.md is the contract; schemas/*.json).
- Existing: src/lib/git-worktrees.ts (resolveGitCommonDir, resolveMainCheckoutRoot, pruneWorktree),
  src/commands/trigger-dispatch.ts (~850: git worktree add + node_modules symlink),
  src/harness/child/worktree.ts + git-worktree-port.ts (provisionWorktrees), doctor `worktrees` check,
  src/memory/store.ts (memoryRootFor("user")), src/learning (keryx learn promote), flow-ids lock in src/flow/allocation.ts.
- Repo is public: no external product names in code/docs/commits. No AI attribution.

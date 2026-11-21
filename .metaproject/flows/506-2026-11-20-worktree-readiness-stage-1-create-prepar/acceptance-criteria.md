# Acceptance Criteria

## Criteria
- AC1: `create` + `prepare` on a fixture repo copy a gitignored `.env`, skip an unignored `.env.local` and name it, and never print file contents. [verify: exec `bun test src/worktree/env-files.test.ts`]
- AC2: `prepare` copies dependency dirs copy-on-write where supported; a second `prepare` reports `skipped`; a changed lock file triggers the install command. [verify: exec `bun test src/worktree/deps.test.ts`]
- AC3: Two worktrees get different ports; `remove` frees a port; a recreated worktree of the same name gets a new `checkoutId` and inherits no records; a port bound by another process is skipped. [verify: exec `bun test src/worktree/ports.test.ts`]
- AC4: `prepare` writes only to the worktree working copy and its git dir (worktree `git status --porcelain` empty, main checkout unchanged) and `keryx worktree exec -- printenv PORT` prints the allocated port. [verify: exec `bun test src/worktree/prepare.test.ts src/worktree/exec.test.ts`]
- AC5: `promote --dry-run` lists an uncommitted memory entry and an accepted project learning entry; `promote` copies memory to the user area under a lock and calls the learn promote path; the main and sibling checkouts are unchanged; without a TTY only `--dry-run` works; `remove` refuses a worktree with unpromoted entries without `--force`. [verify: exec `bun test src/worktree/promote.test.ts src/worktree/remove.test.ts`]
- AC6: A prepared worktree has its memory index rebuilt and memory search finds a committed branch entry without a manual index step. [verify: exec `bun test src/worktree/metaproject.test.ts`]
- AC7: A session, a subagent started through `provisionWorktrees`, an external agent and `trigger run` receive the two lines (absolute worktree root, `<root>/.metaproject/index.md`) in their starting context. [verify: exec `bun test src/worktree/agent-lines.test.ts src/harness/child`]
- AC8: `keryx trigger run` creates its worktree through `src/worktree`, with existing trigger tests still green. [verify: exec `bun test src/commands/trigger-dispatch.test.ts`]
- AC9: `keryx doctor`'s `worktrees` check reports checkout label, ports, prepare state and unpromoted entries for the current worktree. [verify: exec `bun test src/commands/doctor.test.ts`]
- AC10: No worktree command invokes `git stash`, `git add`, `git commit` or `git push` (git-wrapper test). [verify: exec `bun test src/worktree/no-forbidden-git.test.ts`]
- AC11: A config with a port range whose lower bound exceeds the upper, or with `..` in paths, is rejected by the loader naming the field. [verify: exec `bun test src/worktree/config.test.ts`]
- AC12: Demo: `keryx worktree create demo`, then `bun test src/lib` runs in it without an install, the memory index exists, and a new memory entry lands in `~/.keryx/memory` after `promote` while the main checkout stays unchanged. [verify: judged]
- AC13: `bun test src/worktree src/testing src/flow` and `bun run typecheck` pass. [verify: exec `bun run typecheck`]

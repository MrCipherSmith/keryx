# Implementation Plan

## Approach
New module `src/worktree/` with small files and a thin CLI layer
(`src/commands/worktree.ts`) following the existing command-registration pattern.
Spec sections: §3 storage, §4 config, §5 metaproject, §6 CLI, §7.1-7.3 contracts, §8
integration points. Per-worktree data lives in the worktree's own git dir
(`git rev-parse --git-dir`) under `keryx/`; the port journal in `<common-dir>/keryx/`.
No command runs git stash/add/commit/push. Tests use real temp git repos.

Files (under src/worktree/ unless noted): config.ts (loader + validation, AC11),
checkout.ts (label, checkoutId), git.ts (git helpers), env-files.ts, deps.ts,
ports.ts (journal + lock + bind probe), worktree-env.ts (env/exec), prepare.ts,
create.ts, status.ts, remove.ts, promote.ts, agent-lines.ts (§5.3), index.ts barrel;
src/commands/worktree.ts + registration; integration edits in
src/commands/trigger-dispatch.ts, src/harness/child/{worktree,git-worktree-port}.ts,
session start context, external agent run, src/commands/doctor.ts.

## Steps
T5 foundations (config, checkout, git helpers, env-files, deps) -> T6 ports/env/exec ->
T7 prepare/create/status/remove/promote + CLI -> T8 integration (agent lines, trigger run,
subagents, external agents, doctor) -> T9 end-to-end verify.

State × event matrix: not applicable — CLI and file-system module, no UI or held state.

## Risks
- `.env` secrets: copy only gitignored files, never print contents (tests assert).
- Concurrent port allocation: lock file; test with parallel allocation.
- Trigger-run refactor must keep its existing tests green.
- Other sessions work in apps/desktop; do not touch it.

# Implementation Plan

Status: approved by operator instruction (operator chat channel 172447)

## Approach

A per-session shadow git repository (separate GIT_DIR under the session directory, work tree = project root) snapshots the tree with `git add -A` + `git write-tree`/commit inside the shadow only. The snapshot is taken lazily at the `executeCall` mutation seam (first write/shell/destructive/delegate call of a turn). Turn markers are archive indexes so `/compact` cannot invalidate them. Rejected: using the project's own git (stash/commits would pollute the operator's history); copying files (slow, no dedup).

## Steps

1. `src/rewind/shadow.ts`: init/open the shadow repo, env isolation (GIT_DIR, GIT_WORK_TREE, scrub inherited GIT_*), exclude rules (.git, node_modules, .metaproject/data, gitignored, >5 MB).
2. `src/rewind/snapshot.ts`: lazy per-turn snapshot hook, wired at the mutation seam in agent.ts; snapshot index kept in the session record.
3. `src/rewind/restore.ts`: pre-rewind snapshot, restore of modified/created/deleted files, report of skipped files.
4. `src/rewind/history.ts`: truncate history + archive to the chosen turn through the session store, lease-guarded.
5. Retention (50 per session), cleanup with the session, `KERYX_REWIND=off`, unattended-run guard.
6. TUI: `/rewind` slash entry, modal picker, sidebar section, readline text equivalent, READLINE_AGENT_COMMANDS.
7. Docs, README, CHANGELOG, version bump.

## Risks

- Large trees make `git add -A` slow: snapshot lazily and only when a mutation is about to happen; report timing.
- Inherited GIT_DIR from hooks corrupting the wrong repo: scrub and test explicitly.
- Rewinding files while history is left in place, or the reverse, confuses the model: the picker names the choice and confirms.

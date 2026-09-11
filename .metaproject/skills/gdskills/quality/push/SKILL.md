---
name: push
description: "Use when pushing the current branch to the remote, especially when upstream tracking or safety checks are needed. NOT for creating the commits themselves (use `commit`) or opening a pull request afterwards (use `pr`)."
triggers:
  - "push branch"
  - "git push"
  - "publish branch"
  - "Push changes"
  - "Push to remote"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Smart Push

Push current branch to remote with safety checks.

## Workflow

### Phase 1: Pre-flight
Run in parallel where possible:
1. `git status` — check for uncommitted changes
2. `git branch -vv` — check current branch and tracking info
3. `git log @{upstream}..HEAD --oneline 2>/dev/null` — commits to push

### Phase 2: Safety Checks
- If there are uncommitted changes → warn and ask if they want to commit first
- If on `main` or `master` → warn and ask for confirmation
- If branch has no upstream → use `git push -u origin <branch>`

### Phase 3: Push
- Normal case: `git push`
- No upstream: `git push -u origin $(git branch --show-current)`
- NEVER use `--force` unless the user explicitly says "force push"

### Phase 4: Confirm
Show result: confirm push success with commit count.

## Arguments

- `/push` — standard push
- `/push --force` — force push (only when explicitly requested, warn if main/master)
- `/push origin <branch>` — push to specific remote/branch

## Rules

- NEVER force push to main/master without double confirmation
- NEVER use `--no-verify`
- If push is rejected (non-fast-forward), suggest `git pull --rebase` first

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "It was rejected, but `--force-with-lease` is safe enough here" | The lease only compares against the ref you last fetched. A teammate's push that landed since then is still discarded, silently. Rebase and push normally, or ask |
| "It's my own feature branch, so a force push hurts nobody" | Open PRs, CI runs, review threads and other worktrees read that ref. Rewriting it invalidates all of them. Force only when the user says "force push" in this conversation |
| "There are uncommitted changes, but they're unrelated to what I'm pushing" | The push ships what is committed, so unrelated work silently stays behind while the branch looks complete to a reviewer. Warn and ask before pushing over a dirty tree |
| "No upstream is set, so `git push origin HEAD` will do" | That leaves the branch untracked, and every later `git status` / `git push` has to guess. Use `git push -u origin <branch>` so the tracking is recorded once |
| "The pre-push hook is slow and this is a tiny change" | `--no-verify` is never the answer here — a tiny change is exactly what an unrun hook lets through |

## Verification

Do not report the push as done until all of the following hold:

- `git status` reports the branch up to date with its upstream
- `git branch -vv` shows an upstream for the current branch (set with `-u` if it had none)
- `git log @{upstream}..HEAD --oneline` is empty — nothing left unpushed
- The report states the commit count pushed and the remote/branch they landed on
- `--force` was used only if the user asked for it in this conversation, and never against main/master without double confirmation

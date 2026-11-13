---
name: git-publish
description: "Use when committing changes, pushing a branch to the remote, or opening a pull request: commit, push and PR rules for staging, hooks, upstream and force. NOT for documenting a pull request that is already open, or its linked issue (use `pr-issue-documenter`)."
triggers:
  - "commit changes"
  - "git commit"
  - "conventional commit"
  - "Commit this"
  - "push branch"
  - "git push"
  - "publish branch"
  - "Push to remote"
  - "open PR"
  - "create pull request"
  - "draft PR"
  - "Open pull request"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Git publishing rules

Apply to every commit, push and pull request you create.

## Commit

- Stage explicit paths that belong to the change. Never `git add -A`, `--all` or `.`, never `commit -a`:
  other agents or the user may have unrelated edits in the same tree.
- Never stage `.env`, credentials, keys or large binaries. Ask before staging an untracked file that
  does not look like part of this change.
- Subject `<type>(<scope>): <description>`, English, at most 72 characters, naming the change.
- No `Co-Authored-By` or "Generated with" trailers.
- Never `--no-verify`. If a hook fails, fix the cause, re-stage and make a new commit; amend only when
  the user asked for an amend.

## Push

- Ask first if the tree has uncommitted changes, or if the branch is `main`/`master`.
- A branch without an upstream is pushed with `git push -u origin <branch>`.
- Never force (`--force`, `--force-with-lease`, `+ref`) unless the user said "force push" in this
  conversation. A rejected push is rebased onto the remote and pushed normally, or handed back.

## Pull request

- Push the branch with `-u` before `gh pr create`; never open a PR from `main`/`master` or over a
  dirty tree without asking.
- Title under 70 characters describing the whole branch. Body covers every commit in
  `<base>..HEAD`: Summary, Changes, Test plan.
- Reference only issues the branch or its commits actually link; never guess a `Closes #N`.
- Ask before opening a PR of 10 or more commits.
- Report the PR URL.

## Verification

- Done when `git show --stat HEAD` lists exactly the intended files.
- Done when `git log @{upstream}..HEAD` is empty.

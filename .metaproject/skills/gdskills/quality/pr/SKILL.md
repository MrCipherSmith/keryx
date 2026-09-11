---
name: pr
description: "Use when opening a pull request for the current branch. NOT for rewriting the body of a pull request that already exists or its linked issue (use `pr-issue-documenter`)."
triggers:
  - "open PR"
  - "create pull request"
  - "draft PR"
  - "Open pull request"
  - "Make PR"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Smart PR Creation

Create a well-documented GitHub Pull Request from current branch.

## Workflow

### Phase 1: Gather Context
Run in parallel:
1. `git status` — check for uncommitted changes
2. `git branch --show-current` — current branch name
3. `git log --oneline main..HEAD` (or master) — all commits in this branch
4. `git diff main...HEAD --stat` — changed files summary

### Phase 2: Pre-checks
- If there are uncommitted changes → ask if the user wants to commit first
- If branch is not pushed → push it with `-u origin`
- If already on main/master → error: "Create a feature branch first"

### Phase 3: Analyze Changes
Analyze ALL commits and changes (not just the latest):
- `git diff main...HEAD` for the full diff
- Understand the scope: new feature, bugfix, refactor, etc.

### Phase 4: Generate & Create PR
Generate structured PR:
- **Title**: short, under 70 chars, descriptive
- **Body**: Summary + Changes + Test plan

```bash
gh pr create --title "title" --body "$(cat <<'EOF'
## Summary
<bullet points>

## Changes
<key changes by area>

## Test plan
<how to verify>
EOF
)"
```

### Phase 5: Report
Return the PR URL to the user.

## Arguments

- `/pr` — create PR to default branch (main/master)
- `/pr --draft` — create as draft PR
- `/pr --base <branch>` — target specific base branch
- `/pr <title>` — use provided title instead of generating one

## Rules

- NEVER create empty PRs
- Always analyze ALL commits, not just the last one
- If the branch has linked GitHub issues, reference them in the body
- Ask user for confirmation before creating if there are 10+ commits

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The last commit message already summarizes the work, use it as the body" | A PR is the whole branch, not its tip. Read `main...HEAD`; the earliest commits are usually where the design decision a reviewer needs actually happened |
| "The branch isn't pushed, but `gh pr create` will sort that out" | It either fails or opens a PR against a stale remote head, so the diff a reviewer sees is not the diff you analyzed. Push with `-u origin <branch>` first |
| "The tree is dirty, but the commits are what get reviewed anyway" | Exactly — which means the uncommitted half of the change quietly does not exist in the PR, and the reviewer approves something incomplete. Ask before opening over a dirty tree |
| "There's an open issue that sounds like this work, I'll write `Closes #N`" | `Closes` shuts an issue on merge. Reference only issues the branch or its commits actually link to; a guess closes someone else's ticket |
| "The user asked for a PR, so 40 commits is still just 'create the PR'" | 10+ commits gets a confirmation first. A branch that large is usually two PRs, and saying so is cheaper before the PR exists than after review starts |

## Verification

Do not report the PR as done until all of the following hold:

- `gh pr view --json url,title,body` returns the created PR, with a non-empty body carrying Summary, Changes and Test plan
- The title is under 70 chars and describes the branch, not the last commit
- Every commit in `git log <base>..HEAD` is represented somewhere in the body — no area of the diff goes unmentioned
- The branch has an upstream and the remote head equals local `HEAD`
- The PR URL is returned to the user

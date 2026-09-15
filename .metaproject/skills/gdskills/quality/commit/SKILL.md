---
name: commit
description: "Use when committing code changes and a well-structured conventional commit message is needed, with optional amend or selective staging. NOT for publishing the branch to the remote (use `push`) or opening a pull request (use `pr`)."
triggers:
  - "commit changes"
  - "git commit"
  - "conventional commit"
  - "Commit this"
  - "Save changes"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Smart Commit

Create well-structured git commits from current changes.

## Workflow

### Phase 1: Analyze Changes
1. Run `git status` and `git diff --staged` and `git diff` to understand all changes
2. Run `git log --oneline -5` to match the repo's commit message style
3. Check for conventional commit patterns in history

### Phase 2: Stage Files
If nothing is staged, intelligently stage relevant files:
- Stage modified and new files that are part of the logical change
- **NEVER** stage `.env`, credentials, secrets, or large binary files
- Stage explicit pathspecs (`git add <specific files>`); **NEVER** `git add -A`, `--all`, or `.`
- Ask the user before staging untracked files that look unrelated to recent work

### Phase 3: Generate Commit Message
Analyze the diff and generate a concise commit message:
- First line: `<type>(<scope>): <description>` (under 72 chars)
- Types: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `style:`, `perf:`
- Optional body: explain "why" not "what" (the diff shows "what")
- **NEVER** add "Co-Authored-By" or any co-authorship lines

### Phase 4: Commit
Create the commit using heredoc format:
```bash
git commit -m "$(cat <<'EOF'
type(scope): description
EOF
)"
```

### Phase 5: Verify
Show the result: `git log --oneline -1` and `git status`

## Arguments

- `/commit` — auto-generate message from diff
- `/commit <message>` — use provided message as-is
- `/commit --amend` — amend the last commit (only when explicitly requested)
- `/commit -a` — stage all modified files before committing

## Rules

- NEVER use `--no-verify` or skip hooks
- NEVER add Co-Authored-By lines
- If pre-commit hook fails: fix the issue, re-stage, create a NEW commit (don't amend)
- Follow existing commit message conventions in the repository

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "Everything in the tree is my work, so staging it all is faster" | It is not all your work. A parallel agent, a running lane, or a half-finished edit of the user's rides along invisibly. Never stage by wildcard — list explicit pathspecs |
| "The pre-commit hook failed on a file I didn't touch, `--no-verify` gets me past it" | The hook is the repository's gate, not an obstacle to route around. Fix the issue, re-stage, commit again |
| "The last commit is mine and close enough — I'll amend it" | Amend only when the user explicitly asked. Amending a commit that is already pushed rewrites history someone else has fetched |
| "The diff shows what happened, so `chore: updates` is enough" | The subject line is all a `git log` reader gets. Name the change and its scope in under 72 chars |
| "The user is out of the loop on this untracked file, but it looks like mine" | Untracked files that look unrelated to recent work get a question, not a guess — that is how an `.env` or a scratch dump gets committed |

## Verification

Do not report the commit as done until all of the following hold:

- `git log --oneline -1` shows the new commit, subject in `<type>(<scope>): <description>` form and under 72 chars
- `git show --stat HEAD` lists exactly the intended files — no `.env`, credential, key, or large binary file
- `git status` shows nothing else newly staged that you did not mean to include
- `git show HEAD` carries no `Co-Authored-By` or generated-by trailer
- Hooks ran — no `--no-verify` was passed; if a hook failed, a NEW commit exists rather than an amend

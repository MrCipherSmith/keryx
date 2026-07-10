---
description: Generate changelog from commits between tags or releases
allowed-tools: Bash(git log:*), Bash(git tag:*), Bash(git describe:*), Bash(git rev-list:*)
---

## Context

- All tags (latest first): !`git tag --sort=-creatordate | head -20`
- Commits since last tag: !`git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline 2>/dev/null | head -50`
- Current branch: !`git branch --show-current`

## Your task

Generate changelog for: $ARGUMENTS

- No args → last tag to HEAD
- One arg (tag) → that tag to HEAD
- Two args (e.g. `v1.0.0 v1.1.0`) → between those tags

### Steps

1. Determine commit range from arguments
2. Get full log: `git log <from>..<to> --pretty=format:"%h %s (%an)" --no-merges`
3. Categorize by conventional commit prefix:
   - `feat:` → **Features**
   - `fix:` → **Bug Fixes**
   - `perf:` → **Performance**
   - `refactor:` → **Refactoring**
   - `docs:` → **Documentation**
   - `chore:` / `build:` / `ci:` → **Maintenance**
   - `test:` → **Tests**
   - uncategorized → **Other Changes**

4. Output:
```markdown
## [version] — YYYY-MM-DD

### Features
- Description (abc1234)

### Bug Fixes
- Description (abc1234)
```

5. Also output compact version for `gh release create --notes`

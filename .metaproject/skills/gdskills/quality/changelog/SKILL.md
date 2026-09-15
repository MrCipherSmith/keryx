---
name: changelog
description: "Use when generating a changelog, release notes, or summarizing what changed between tags, versions, or date ranges. NOT for describing a single pull request or its linked issue (use `pr-issue-documenter`)."
triggers:
  - "generate changelog"
  - "release notes"
  - "what changed"
  - "What changed since"
  - "What's new"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Changelog Generator

Generate structured changelog from git history.

## Arguments

- `/changelog` — latest tag to HEAD
- `/changelog v1.0..v2.0` — between tags
- `/changelog --since 2024-01-01` — since date
- `/changelog --output <file>` — write to file
- `/changelog --prepend` — prepend to existing CHANGELOG.md
- `/changelog --format compact` — one-liner per change

## Workflow

### Step 1: Determine Range
1. `git tag --sort=-version:refname` — list recent tags
2. Default: from latest tag to HEAD
3. Between tags or since date if specified

### Step 2: Collect Commits
```bash
git log <range> --pretty=format:"%H|%s|%an|%ad" --date=short
```

### Step 3: Parse & Classify

| Prefix | Section |
|--------|---------|
| feat: | Features |
| fix: | Bug Fixes |
| perf: | Performance |
| refactor: | Refactoring |
| docs: | Documentation |
| test: | Tests |
| chore: | Maintenance |
| BREAKING CHANGE | Breaking Changes |

Extract scope, PR references `(#123)`, issue references `fixes #456`.

### Step 4: Enrich (optional)
If `gh` CLI available: fetch PR titles for merge commits, get authors and labels.

### Step 5: Generate Output

```markdown
# Changelog

## [v1.3.0] - 2024-03-15

### Breaking Changes
- **auth**: Remove deprecated OAuth1 support (#234)

### Features
- **api**: Add batch processing endpoint (#220)

### Bug Fixes
- **db**: Fix connection pool leak under load (#228)
```

## Rules

- Deduplicate identical commit messages
- Skip merge commits (use PR title instead)
- If no conventional commits found, fall back to plain list by date
- Breaking changes always go first
- One line per change

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This commit has no `feat:`/`fix:` prefix, but it reads like a feature — I'll file it under Features" | Classification comes from the commit's own prefix. Guessing a section invents a release note nobody wrote. Unprefixed commits go to the plain dated fallback list |
| "The subject is terse, so I'll describe what the change probably did" | You read the log, not the diff. A changelog entry that states an effect the commit never claimed is a false release note that ships to users |
| "No tag matches the range, so I'll start from the first commit" | That silently turns "since last release" into the project's whole history. State the range you could not resolve and ask, rather than emitting a thousand-line changelog |
| "The merge commit summarizes the branch nicely, keep it alongside the branch's commits" | It double-counts: the merge subject and the commits underneath describe the same work. Use the PR title, drop the merge |
| "The type is `fix:` so it belongs in Bug Fixes, even though the body says BREAKING CHANGE" | `BREAKING CHANGE` outranks the type prefix. A breaking change filed under Bug Fixes is the entry a reader upgrades past without noticing |

## Verification

Do not report the changelog as done until all of the following hold:

- The range actually used (tag-to-tag, tag-to-HEAD, or `--since` date) is stated in the output, including when it was a fallback
- Every commit in `git log <range> --oneline` is either an entry or a deliberate skip (merge commit, exact duplicate) — none dropped silently
- No section header is emitted with zero entries under it
- Breaking Changes, when present, is the first section
- With `--output` / `--prepend`: the target file exists, the pre-existing content is still intact, and the new block sits at the top rather than replacing it

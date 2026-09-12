---
name: dependency-update
description: "Use when checking for outdated packages or upgrading dependencies with compatibility verification. NOT for finding which packages are vulnerable in the first place (use `security-audit`)."
triggers:
  - "update dependencies"
  - "upgrade packages"
  - "bump deps"
  - "Check outdated"
  - "Update npm packages"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Dependency Update

Safely update project dependencies with compatibility checks.

## Arguments

- `/dependency-update` — check and propose updates
- `/dependency-update --patch` — only patch updates (safe)
- `/dependency-update --minor` — patch + minor
- `/dependency-update --all` — all including major
- `/dependency-update --dry-run` — show what would update
- `/dependency-update <package>` — update specific package

## Workflow

### Step 1: Check Outdated
```bash
npm outdated --json
```

### Step 2: Classify by Risk

| Type | Risk | Action |
|------|------|--------|
| Patch (1.0.0 → 1.0.1) | Low | Batch update |
| Minor (1.0.0 → 1.1.0) | Medium | Update & test |
| Major (1.0.0 → 2.0.0) | High | One-by-one with tests |

### Step 3: Present Update Plan
Show grouped list with risk levels. Get user confirmation.

### Step 4: Execute

**Patch (batch):** `npm update`

**Minor (batch):** `npm install pkg1@latest pkg2@latest && npm test`

**Major (one at a time):**
1. Check changelog/migration guide
2. `npm install <package>@latest`
3. Run lint + type-check + tests
4. If fails (max 2 fix tries) → rollback
5. If passes → commit: `chore(deps): update <package> to v<version>`

### Step 5: Post-update Verification
```bash
npm run lint && npx tsc --noEmit && npm test && npm run build
```

### Step 6: Report
```
✅ Updated: 15 packages (10 patch, 4 minor, 1 major)
⚠️ Skipped: 2 packages (tests fail)
📋 Commits: 3
```

## Rules

- NEVER update all major versions at once — one by one
- ALWAYS run tests after each major update
- Rollback if tests fail
- Commit each group separately
- Respect pinned versions
- Check peer dependency warnings

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The suite passes with all of them installed, so batching the majors saved five rounds" | When it breaks you cannot tell which major did it, and bisecting a batch costs more than the rounds you saved. Majors go one at a time, tests after each (Step 4) |
| "Tests broke after the major bump — I'll migrate the call sites while I'm here" | Two fix attempts, then rollback. An open-ended API migration is a separate task with its own review; smuggling it into a dependency bump hides it from everyone |
| "This version is pinned, but the pin looks stale" | A pin is a decision someone made, usually about a break you cannot see from `npm outdated`. Report it as pinned and let the user unpin it |
| "`npm outdated` printed nothing, so the project is up to date" | It prints nothing when the lockfile belongs to a different package manager. Detect from the lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`) before concluding "current" |
| "Peer dependency warnings are warnings, not errors" | They are the standard cause of the runtime failure that shows up two commits later, in something that was never touched. Carry them into the report |
| "One commit for the whole update is tidier than three" | It makes the one bad package unrevertable without dropping the good ones. Commit per risk group, as Step 4 specifies |

## Exit Criteria

Do not report the update as done until all of the following hold:

- `npm run lint && npx tsc --noEmit && npm test && npm run build` — or the project's own equivalents — all pass on the final tree
- Every major was applied and tested on its own, with its own commit; no major shares a commit with another
- Every package the plan proposed is accounted for in the report as updated, skipped (with the reason), or rolled back
- `git status` is clean and the lockfile is committed alongside the manifest it belongs to
- Pinned versions are unchanged, and peer dependency warnings that appeared are listed in the report

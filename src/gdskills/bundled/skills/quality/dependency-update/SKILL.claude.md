---
description: Update dependencies with compatibility checks and test verification
allowed-tools: Bash(*), Read(*), Edit(*), Write(*)
---

## Context

- Package manager: !`ls bun.lockb 2>/dev/null && echo "bun" || ls yarn.lock 2>/dev/null && echo "yarn" || echo "npm"`
- Outdated packages: !`bun outdated 2>/dev/null || npm outdated 2>/dev/null | head -30`
- Test script: !`cat package.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('scripts',{}).get('test','none'))" 2>/dev/null`

## Your task

Update dependencies: $ARGUMENTS (empty = all outdated)

### Steps

1. **Snapshot**: `cp package.json package.json.backup`

2. **Categorize** updates: patch / minor (auto) vs major (manual analysis)

3. **Apply patch + minor**:
```bash
bun update 2>/dev/null || npx npm-check-updates -u --target minor && npm install
```

4. **Run tests**:
```bash
bun test 2>/dev/null || npm test 2>/dev/null
```
If fail → identify breaking update → rollback that package

5. **For major updates** (if in args or --major flag):
   - Check CHANGELOG/GitHub releases for breaking changes
   - Report: what needs updating in codebase
   - Apply only if no breaking changes affect this project

6. **Always update** packages with known CVEs regardless of version jump

7. **Restore on failure**: `cp package.json.backup package.json && bun install`

### Final report
- Updated: old → new versions
- Skipped: package + reason
- Manual action: major changes requiring code updates

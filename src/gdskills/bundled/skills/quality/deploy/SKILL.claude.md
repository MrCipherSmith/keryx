---
description: Run tests, build, and deploy to target environment
allowed-tools: Bash(*), Read(*), Edit(*)
---

## Context

- Current branch: !`git branch --show-current`
- Git status: !`git status --short`
- Recent commits: !`git log --oneline -5`
- Config files: !`ls -1 .env* docker-compose*.yml Dockerfile pm2* ecosystem.config.* 2>/dev/null || echo "none"`
- Package scripts: !`cat package.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print(k+':',v) for k,v in d.get('scripts',{}).items()]" || echo "no package.json"`

## Your task

Deploy to environment: $ARGUMENTS (default: production if not specified)

### Phase 1 — Pre-flight
1. Verify git status — warn if dirty, continue if user confirms
2. Check target env config exists
3. Verify required env vars set

### Phase 2 — Tests
1. Run: `bun test` / `npm test` / `jest` / `vitest` (auto-detect)
2. **STOP and report if any tests fail — do not deploy**

### Phase 3 — Build
1. Detect: `bun build` / `docker build` / `npm run build`
2. **STOP and report if build fails**

### Phase 4 — Deploy
Detect method:
- `docker-compose.yml` → `docker compose up -d --build`
- `Dockerfile` only → build + run container
- `ecosystem.config.*` → `pm2 reload`
- Custom deploy script → run it

### Phase 5 — Verify
1. Check service running: `docker ps` / `pm2 status` / health endpoint
2. Show last 20 log lines

Report result of each phase clearly.

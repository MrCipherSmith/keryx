---
name: deploy
description: "Use when deploying to any environment (staging, production) or when a deployment pipeline needs to run. NOT for the database schema changes a release depends on (use `db-migrate`)."
triggers:
  - "deploy"
  - "deployment"
  - "ship"
  - "release"
  - "Deploy to"
  - "Push to production"
  - "Deploy staging"
  - "Ship it"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Deploy

Automated deployment pipeline with pre-flight checks.

## Arguments

- `/deploy` — deploy to staging (default)
- `/deploy production` — deploy to production (requires confirmation)
- `/deploy --skip-tests` — skip test phase
- `/deploy --dry-run` — show what would happen without executing
- `/deploy <env> --rollback` — rollback to previous version

## Workflow

### Phase 1: Detect Project Type & Deploy Target
1. Read `package.json`, `docker-compose.yml`, `Dockerfile`, `vercel.json`, `railway.json`, `ecosystem.config.js`, `Makefile`
2. Detect stack: Node/Bun/Python/Go/Docker
3. Detect deploy target: Docker Compose, PM2, SSH, Vercel, Railway, custom script
4. Determine environment from argument (default: staging)

### Phase 2: Pre-flight Checks
Run in parallel where possible:
1. **Git status**: working tree clean (warn if dirty)
2. **Branch check**: correct branch for target env (production → main/master)
3. **Tests**: `npm test` / `pytest` / `go test ./...` (skip with `--skip-tests`)
4. **Lint**: `npm run lint` if available
5. **Type-check**: `keryx health run --source typescript` if TypeScript (`src/health/sources/typescript.ts` resolves the real invocation, never a hardcoded `npx tsc`; on a project with no keryx health config, fall back to its own configured type-check command)
6. **Build**: `npm run build` / `docker build`

If any check fails → stop and report.

### Phase 3: Deploy

| Target | Command |
|--------|---------|
| Docker Compose | `docker compose build && docker compose up -d` |
| PM2 | `pm2 reload ecosystem.config.js --env <env>` |
| SSH | `ssh <host> "cd <path> && git pull && npm install && npm run build && pm2 reload all"` |
| Vercel | `vercel --prod` or `vercel` (preview) |
| Custom | `npm run deploy:<env>` or `make deploy` |

### Phase 4: Post-deploy Verification
1. Health check: curl the health endpoint
2. Check logs for startup errors
3. Report: deployed version, environment, status

## Rules

- ALWAYS require explicit confirmation for production deploys
- NEVER deploy with failing tests (unless `--skip-tests`)
- NEVER deploy from dirty working tree without warning
- Show summary before deploying: branch, env, target, version
- If deploy target can't be detected, ask the user

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "That test is flaky, `--skip-tests` just this once" | `--skip-tests` is a flag the user passes, never one you add. Report the failing test and let them decide whether it is flaky — from inside the run you cannot tell flaky from newly broken |
| "The tree is dirty, but only with files unrelated to the deploy" | A deploy from a dirty tree ships an artifact that matches no commit, so it cannot be reproduced, diffed, or rolled back to a known state. Warn, and get an answer before proceeding |
| "The user said 'ship it', so production is confirmed" | Production takes a confirmation that names production. "Ship it" is how a staging deploy gets requested at least as often |
| "The deploy command exited 0 — done" | Exit 0 means the command ran, not that the process came up. Health-check the endpoint and read the startup logs before reporting success (Phase 4) |
| "I can't tell the target for certain, but `vercel.json` is here so Vercel is a fair bet" | A guessed deploy target deploys to a real environment. When detection is ambiguous, ask — the cost of the question is one message, the cost of the guess is an unplanned release |

## Exit Criteria

Do not report the deploy as done until all of the following hold:

- Every Phase 2 pre-flight check either passed or was skipped by a flag the user passed — none skipped on your own judgment
- For a production target: an explicit confirmation naming production exists in this conversation, and the summary (branch, env, target, version) preceded it
- The health endpoint responded successfully after the deploy, and the startup logs show no errors
- The report states the environment, the detected target, the deployed version/commit, and the result of the health check
- For `--dry-run`: nothing was executed — the report shows only what would have run

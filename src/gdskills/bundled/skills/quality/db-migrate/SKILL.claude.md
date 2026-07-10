---
description: Create and apply database migrations (Drizzle, Prisma, Knex, raw SQL)
allowed-tools: Bash(*), Read(*), Write(*), Glob(*)
---

## Context

- Migration tool: !`ls drizzle.config.* knexfile.* prisma/schema.prisma 2>/dev/null | head -3 || echo "none found"`
- Existing migrations: !`ls migrations/ db/migrations/ prisma/migrations/ 2>/dev/null | tail -10 || echo "none"`
- DB env: !`grep -E "DATABASE_URL|DB_HOST|POSTGRES" .env 2>/dev/null | sed 's/=.*/=***/' || echo "no .env"`
- Migration scripts: !`cat package.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print(k+':',v) for k,v in d.get('scripts',{}).items() if any(x in k for x in ['migrat','drizzle','prisma'])]" 2>/dev/null || echo "none"`

## Your task

Action: $ARGUMENTS (e.g. `create add_user_sessions_table`, `apply`, `status`, `rollback`)

### Detect tool
- `drizzle.config.*` → Drizzle ORM
- `prisma/schema.prisma` → Prisma
- `knexfile.*` → Knex
- `migrations/*.sql` → Raw SQL

### `create <name>`
- Drizzle: `bunx drizzle-kit generate`
- Prisma: `bunx prisma migrate dev --name <name>`
- Knex: `npx knex migrate:make <name>`
- Raw SQL: create `migrations/YYYYMMDD_HHMMSS_<name>.sql` with UP/DOWN, scaffold SQL from name

### `apply` / empty
- Drizzle: `bunx drizzle-kit migrate`
- Prisma: `bunx prisma migrate deploy`
- Knex: `npx knex migrate:latest`

### `status`
Show applied vs pending

### `rollback`
Roll back last migration

Always show SQL before running, confirm success after.

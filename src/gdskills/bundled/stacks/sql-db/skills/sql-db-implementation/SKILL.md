---
name: sql-db-implementation
description: "Use when writing raw SQL schema, migrations, or queries for Postgres/MySQL -- safe zero-downtime schema changes (adding NOT NULL, backfills), indexing (composite column order, covering/partial indexes), transaction discipline, and parameterized query design. Not for an ORM's own schema/migration file (a Prisma schema, a Django models.py, a Rails db/migrate .rb, or a Laravel migration .php) -- those belong to that stack's own implementation skill."
triggers:
  - "write a migration that adds a NOT NULL column to this table"
  - "design an index for this query's WHERE clause"
  - "add a foreign key without locking the table in production"
  - "write a safe backfill for this large table"
  - "fix this N+1 by rewriting it as a single query"
  - "wrap these related writes in a transaction"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# SQL / database implementation (Postgres, MySQL, generic SQL)

Write or extend a schema, migration, or hand-written query: zero-downtime
migration sequencing, index design, transaction discipline, and
parameterized query construction across Postgres, MySQL, and generic SQL
engines. `rules/coding-style.mdc`, `rules/patterns.mdc`, and
`rules/security.mdc` carry the full rule set this skill's checklist draws
from — read them before writing SQL, not just this summary. This pack
narrows the general guidance in the core `database-patterns.mdc` rule with
concrete, engine-specific mechanics.

## Workflow

### Step 1: Discover the project's own conventions and engine

1. Identify the engine (Postgres vs. MySQL vs. another SQL dialect) from
   the project's connection config, migration tool config, or an existing
   `.sql` file's syntax — the safe migration mechanics below differ by
   engine.
2. Find the migration tool already in use (a framework's own migration
   runner, `Flyway`/`Liquibase`, plain numbered `.sql` files) and match
   its existing naming and up/down (or up-only) convention; do not
   introduce a second migration mechanism into a project that already has
   one.
3. Read 1-2 existing migrations and 1-2 existing query files for naming
   conventions (`rules/coding-style.mdc`), whether the project already has
   an established pattern for safe `NOT NULL` additions or backfills, and
   whether raw SQL or a query builder/ORM is the project's norm.
4. Check the table's approximate row count (or ask, if it isn't
   discoverable) before deciding whether a schema change needs the
   zero-downtime multi-step sequence — a near-empty table doesn't need
   the same care as one with millions of rows, but a migration written
   for a small table today should still be safe if that table grows.

### Step 2: Design before writing

- For a schema change: classify it against `rules/patterns.mdc`'s
  zero-downtime table (nullable column add, `NOT NULL` with constant
  default, `NOT NULL` needing backfill, rename, type change, drop) and
  pick the corresponding safe sequence — do not default to a single
  blocking `ALTER TABLE` for anything beyond a nullable-column add on a
  table that can plausibly grow large.
- For a new query: identify every `WHERE`/`JOIN ON`/`ORDER BY` column and
  check whether it's already indexed; if not, design the index alongside
  the query in the same change, with composite column order matching the
  query's actual equality-then-range filter shape.
- For a query inside a loop (fetching a collection, then a per-item
  detail): redesign it as one query — a `JOIN`, an `IN (...)` batch, or an
  ORM eager-load option — before implementing, not as a follow-up
  optimization.
- Decide whether related writes need a transaction: any write touching
  more than one table, or more than one row-affecting statement against
  the same table where a partial failure would leave the data
  inconsistent, needs one.

### Step 3: Implement

1. Write the migration/query following `rules/coding-style.mdc`'s naming
   and formatting, matching the project's existing convention over this
   rule set when the two conflict on a purely stylistic point.
2. Apply the zero-downtime sequence chosen in Step 2; split a migration
   that combines a blocking schema change with a potentially slow
   backfill into separate migration files per `rules/patterns.mdc`.
3. Parameterize every value — placeholders or the ORM's parameter API,
   never string concatenation/interpolation of a value into SQL text, per
   `rules/security.mdc`. This applies equally inside `PL/pgSQL`/stored
   procedure dynamic SQL.
4. Add the index(es) designed in Step 2 in the same change as the query
   that needs them, with a comment stating which query a non-obvious
   index (a partial predicate, a surprising composite order) serves.
5. Wrap multi-statement/multi-table writes in an explicit transaction;
   keep the transaction's lifetime to database work only — commit before,
   or reopen after, any slow external call.

### Step 4: Verify

```sql
EXPLAIN (ANALYZE, BUFFERS) <the new/changed query>;   -- Postgres
EXPLAIN ANALYZE <the new/changed query>;                -- MySQL
```

Confirm the plan uses the intended index (an Index Scan/Index-Only Scan,
not an unplanned Seq Scan/full table scan on a table with meaningful row
count). Run the migration against a representative-sized dataset when one
is available, not just an empty dev database.

### Step 5: Report

```
Implemented: migrations/2026_09_25_add_orders_status_index.sql,
             src/orders/queries.sql
  - NOT VALID + VALIDATE CONSTRAINT sequence for the new NOT NULL column
  - Composite index (status, created_at) added for the new list-orders query
  - EXPLAIN ANALYZE confirms Index Scan, no Seq Scan
```

## Rules

- Never build a query by string concatenation or interpolation of a
  user-influenced value into SQL text — use placeholders/parameter
  binding, including inside an ORM's raw-SQL escape hatch and inside
  stored-procedure dynamic SQL.
- Never add a blocking `NOT NULL` or a blocking index-creation statement
  to a migration touching a table that can have existing rows without
  first checking whether the engine's non-blocking form (`NOT VALID` +
  `VALIDATE CONSTRAINT`, `CREATE INDEX CONCURRENTLY`) applies.
- Never leave a `WHERE`/`JOIN`/`ORDER BY` column added by this change
  unindexed without checking `EXPLAIN`/`EXPLAIN ANALYZE` first.
- Never issue a query inside an application-code loop once per row of an
  outer result set — rewrite as a single batched query.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just `ALTER TABLE ... ADD COLUMN ... NOT NULL` directly, the table isn't that big" | "Not that big" today doesn't stay true; a plain `SET NOT NULL`/blocking constraint add on Postgres takes a full-table-scanning lock, and the safe `NOT VALID` + `VALIDATE CONSTRAINT` sequence costs nothing extra when the table is genuinely small |
| "I'll build this filter with string formatting since the value comes from our own config, not a user" | "Our own config" today can become user-influenced tomorrow (an admin panel, an import feature) without anyone revisiting this query; parameterize from the start |
| "The loop is only iterating a handful of rows in dev, one query per row is fine" | Dev data is rarely production-sized; an N+1 that's invisible at 10 rows becomes a real latency/load problem at 10,000 |
| "I'll add the index after it ships if the query turns out slow" | `CREATE INDEX CONCURRENTLY`/`ALGORITHM=INPLACE` exist specifically so adding it now costs no more than adding it later — there's no reason to defer and risk forgetting |

## Verification

Do not report the work done until all of the following hold:

- Every value in every query is parameterized; no string concatenation or
  interpolation of a user-influenced value into SQL text anywhere in the
  change.
- Every schema change touching a table that can have existing rows uses
  the zero-downtime sequence from `rules/patterns.mdc` appropriate to its
  category, not a single blocking statement, unless the table is
  genuinely new in this same change.
- `EXPLAIN`/`EXPLAIN ANALYZE` was run on every new or materially changed
  query and shows the intended index usage.
- Every multi-table or multi-statement write is wrapped in an explicit
  transaction whose lifetime does not span a slow external call.

---
name: sql-db-code-review
description: "Use when reviewing a raw .sql migration or query diff for SQL/database-specific risk -- injection (string-built SQL, ORM raw-SQL escape hatches), missing/misordered indexes, an unsafe blocking NOT NULL or index-creation statement, N+1 query shape, and transactions left open across a slow call. Not for reviewing a Rails ActiveRecord or Django ORM migration file (a .rb/.py migration -- use that stack's own code-review skill), and not for a non-SQL source file's injection risk in general application code (use that language's own code-review skill). Read-only, no edits."
triggers:
  - "review this migration diff for safety before we merge it"
  - "check this query diff for SQL injection"
  - "does this migration lock the table when it runs"
  - "review this diff for a missing index on the new WHERE clause"
  - "check this diff for an N+1 query pattern"
  - "review this transaction for locks held across an external call"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# SQL / database code review (Postgres, MySQL, generic SQL)

Read-only review of a migration or query diff for SQL/database-specific
risk: injection, missing or misordered indexes, unsafe blocking schema
changes, N+1 query shape, and transaction discipline. This skill never
edits code — it reports findings. `rules/patterns.mdc` and
`rules/security.mdc` are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review `.sql` migration/query files in the diff, and any application
   code in the diff that builds or issues SQL (a raw query string, an
   ORM's raw-SQL escape hatch, a stored-procedure call).
2. Read enough surrounding, unchanged schema/query code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.
3. Identify the target engine (Postgres/MySQL/other) so the blocking-lock
   analysis below uses the right engine's actual mechanics.

### Step 2: Check each changed statement against the focus list

**Injection**
- Any SQL text built by concatenating or interpolating a value that
  ultimately traces back to external input (a request parameter, a form
  field, a message payload) — flag it, including inside an ORM's raw-SQL
  escape hatch or a stored procedure's dynamic `EXECUTE`.
- A dynamic identifier (table/column name chosen at runtime) passed with
  no allowlist check — flag it; a value placeholder cannot bind an
  identifier, so this needs explicit validation, not a placeholder.

**Blocking schema changes**
- A `NOT NULL` column or constraint added to a table that can have
  existing rows, with no `NOT VALID` + `VALIDATE CONSTRAINT` sequence
  (Postgres) or no online-DDL consideration (MySQL) — flag a plain
  blocking form on a table sized enough to matter.
- An index added to an existing table without `CONCURRENTLY` (Postgres)
  or without confirming `ALGORITHM=INPLACE`/`LOCK=NONE` (MySQL) — flag it.
- A single unbatched backfill (`UPDATE` with no row-range/batch limiting)
  against a table sized enough for it to hold locks or generate excessive
  WAL/binlog for a meaningful duration — flag it.

**Indexing**
- A new `WHERE`/`JOIN ON`/`ORDER BY` column with no supporting index on a
  table large enough to matter — flag it.
- A composite index whose column order puts a range-filtered or
  `ORDER BY`-only column before an equality-filtered one the query
  actually restricts by — flag it as likely not serving the query
  efficiently, per `rules/patterns.mdc`.

**Query shape**
- A query issued inside a loop over rows from an earlier query (the N+1
  shape) — flag it with the batching/JOIN fix direction.
- `SELECT *` reaching a result set consumed outside the immediate query's
  own trust boundary, or on a table with a sensitive column — flag it.

**Transactions**
- A transaction opened before a slow external call (an HTTP request, a
  queue publish, a sleep) and not committed/closed until after it — flag
  the lock-duration risk.
- A multi-table or multi-statement write with no transaction wrapping it
  at all — flag the partial-failure risk.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (injection,
lock/outage risk, correctness), and the fix direction — but do not apply
it.

```
migrations/2026_09_20_add_verified.sql:4 — ALTER TABLE users ALTER COLUMN
  email_verified SET NOT NULL with no prior NOT VALID + VALIDATE CONSTRAINT
  step, on a table with production row counts. Risk: this ALTER blocks
  concurrent reads/writes for the duration of Postgres's full-table
  verification scan. Fix direction: replace with
  ADD CONSTRAINT ... CHECK (email_verified IS NOT NULL) NOT VALID, then a
  separate VALIDATE CONSTRAINT statement.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag injection risk, blocking schema changes, missing/misordered
  indexes, N+1 shape, and unsafe transaction scope; do not report generic
  formatting nits already covered by `rules/coding-style.mdc`'s
  naming/formatting conventions (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a query's index usage is not certain from reading alone, say "run
  EXPLAIN ANALYZE to confirm" rather than asserting a full scan occurs
  without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This value comes from an internal service, not a user, injection doesn't apply" | An internal caller today can become externally reachable later without this query being revisited; flag string-built SQL regardless of the immediate caller |
| "The table is small right now, the blocking ALTER is fine" | A migration written today runs again on every environment, including production once the table has grown; flag the blocking pattern regardless of current size |
| "The missing index is a performance nit, not a review blocker" | A full-table scan on a hot query path is a production incident waiting to happen, not a style preference; flag it with the same weight as a correctness issue |
| "I'll just add the index myself since it's an obvious one-line fix" | This skill is read-only; report the finding and its fix direction, do not edit the file |

## Verification

Do not report the review done until all of the following hold:

- Every changed `.sql` file and every application-code query/raw-SQL call
  site in the diff was read, not just files named in the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.

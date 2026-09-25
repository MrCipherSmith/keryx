---
name: sql-db-build-fix
description: "Use when a migration fails to apply, a query planner regresses to a full table scan, or a constraint violation blocks a deploy -- resolves failed/broken migrations, missing-index query regressions, deadlocks, and NOT NULL/unique/foreign-key constraint violations with the smallest root-cause fix."
triggers:
  - "this migration is failing to apply, help me fix it"
  - "this query used to use the index and now does a sequential scan"
  - "I'm getting a unique constraint violation running this migration"
  - "this migration is failing with a foreign key violation"
  - "the query planner stopped using this index after the last deploy"
  - "two migrations conflict and one fails to apply"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# SQL / database build fix (Postgres, MySQL, generic SQL)

Resolve a failed or broken migration, a query planner regression (an
index that stopped being used), or a constraint violation blocking a
deploy — with the smallest change that fixes the actual root cause.
`rules/patterns.mdc` and `rules/security.mdc` govern what a "correct" fix
looks like; this skill never reaches for a suppression (dropping a
constraint, skipping a migration step) instead of a fix.

## Workflow

### Step 1: Reproduce and classify

Run the migration/query against a local or staging database that mirrors
the failure, and read the exact error text. Classify it:

- **Migration apply failure** — a DDL statement errors (object already
  exists, object doesn't exist, syntax error, a lock timeout).
- **Constraint violation** — `NOT NULL`, `UNIQUE`, `CHECK`, or foreign-key
  violation raised while running a migration's backfill or while the
  application inserts/updates a row.
- **Planner regression** — a query that used an index before now runs a
  sequential/full-table scan (`EXPLAIN`/`EXPLAIN ANALYZE` shows the
  changed plan).
- **Deadlock/lock timeout** — two transactions each holding a lock the
  other needs, or a migration's lock request timing out against live
  traffic.
- **Migration ordering conflict** — two migrations both claim the same
  version/sequence number, or one depends on schema state a
  not-yet-applied migration would create.

### Step 2: Fix by category

**Migration apply failure:** read the exact error. "Object already
exists" on a re-run usually means the migration isn't idempotent — add
`IF NOT EXISTS`/`IF EXISTS` where the engine supports it, or check
whether a previous partial run needs manual cleanup before retrying
(state which, in the report). Never just delete/skip the migration file
to make the runner stop complaining.

**Constraint violation on backfill or insert:** find the actual row(s)
violating the constraint — do not disable or drop the constraint to make
the error go away. A `NOT NULL` violation during backfill usually means
the backfill's default/derivation logic missed a case (a row with a
legitimately different history); a `UNIQUE` violation usually means
duplicate data existed before the constraint was added — decide the
correct resolution (merge, dedupe, or a documented exception) rather than
loosening the constraint to accept invalid data.

**Planner regression (unused index):** confirm with
`EXPLAIN (ANALYZE, BUFFERS)` (Postgres) / `EXPLAIN ANALYZE` (MySQL)
whether the index still exists, whether statistics are stale
(`ANALYZE <table>` on Postgres, `ANALYZE TABLE` on MySQL, after a large
data change), or whether the query's own shape changed in a way that no
longer matches the index's column order (per `rules/patterns.mdc`'s
composite-order guidance) — fix the actual cause (re-run `ANALYZE`,
correct the index shape) rather than forcing a plan with a planner hint
as the first resort.

**Deadlock/lock timeout:** read which two operations held conflicting
locks (Postgres logs both queries and lock modes in a deadlock error;
MySQL's `SHOW ENGINE INNODB STATUS` shows the last deadlock). Fix by
making both code paths acquire locks in the same order, shortening the
transaction that holds the lock too long, or batching a migration's
backfill into smaller steps that each commit — not by retrying blindly or
raising the lock timeout to paper over the contention.

**Migration ordering conflict:** renumber/rebase the conflicting
migration against the current head per the project's migration tool's own
conflict-resolution convention; never force-apply one migration over
another's recorded state without understanding what schema each expects.

### Step 3: Verify

Re-run the migration end-to-end (up, and down if it has one) against a
representative dataset. Re-run the regressed query with
`EXPLAIN`/`EXPLAIN ANALYZE` and confirm the expected plan. Confirm no
constraint violation remains across the full backfill, not just the row
that originally failed.

### Step 4: Report

```
Fixed: migrations/2026_09_18_backfill_status.sql
  - Root cause: 340 legacy rows had status = '' (not NULL) from a prior
    import, which the backfill's WHERE status IS NULL clause missed
  - Extended the backfill condition to also match status = ''
  - Migration re-run clean against a full-size copy of the table
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER drop or loosen a constraint (`NOT NULL`, `UNIQUE`, a foreign key)
  to make a violation stop erroring instead of fixing the data or the
  logic that produced the violation.
- NEVER delete or skip a failing migration step to reach a "successful"
  migration run.
- NEVER force a query plan with a planner hint as the first fix for a
  regression before checking whether statistics are stale or the index
  shape no longer matches the query.
- NEVER raise a lock/statement timeout to make a deadlock or contention
  error stop appearing without addressing the actual lock ordering or
  transaction duration.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just drop the NOT NULL constraint so the insert succeeds" | Silences the violation without fixing why a NULL reached this point — the constraint existed to catch exactly this; find and fix the actual bad data or code path instead |
| "This migration keeps failing on re-run, I'll delete it and start over" | Deleting a migration that already partially applied against some environments leaves them permanently out of sync with a fresh one; add IF EXISTS/IF NOT EXISTS or fix the idempotency issue instead |
| "The query got slow, I'll just add a planner hint to force the old plan" | A hint papers over the actual cause (stale statistics, a changed index shape) and can go stale itself the next time data distribution shifts; fix the underlying cause first |
| "I'll bump the lock timeout so this migration stops timing out" | A longer timeout doesn't resolve the contention, it just waits longer before the same conflict occurs; fix the lock ordering or shrink the transaction instead |

## Verification

Do not report the fix done until all of the following hold:

- The migration re-runs clean end-to-end (up, and down if applicable)
  against a representative dataset, not just the originally failing row.
- No constraint was dropped or loosened as part of the fix, unless the
  report explicitly states the constraint itself was wrong and why.
- For a planner regression, `EXPLAIN`/`EXPLAIN ANALYZE` confirms the
  expected plan after the fix, not just that the query no longer errors.
- The report states the root cause in one sentence, not just "it works
  now."

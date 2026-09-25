---
name: sql-db-testing
description: "Use when writing or fixing tests for SQL migrations and queries -- transactional test wrapping with rollback, fixture/seed data design, testing a migration's up/down path on representative row counts, and asserting on actual query results and query counts rather than just 'no error'."
triggers:
  - "write a test for this migration's rollback"
  - "add a test that this backfill updates every row exactly once"
  - "test that this query returns the right rows in the right order"
  - "write a regression test for this N+1 fix"
  - "set up transactional test isolation for these database tests"
  - "add a test fixture for an order with an expired token"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# SQL / database testing (Postgres, MySQL, generic SQL)

Write, extend, or fix tests for `.sql` migrations and hand-written
queries: transactional isolation, fixture/seed design, migration up/down
testing at representative scale, and result-based query assertions.
`rules/testing.mdc` carries the full rule set this skill's checklist is
built from — read it, not just this summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Find how the project already isolates database tests: a
   transaction-per-test wrapper, a truncate-and-reseed helper, or a fresh
   container/schema per run. Match whichever is already there rather than
   introducing a second isolation strategy.
2. Read 1-2 existing database tests for fixture/factory helper
   conventions, naming style, and whether the suite already asserts on
   query counts anywhere (a query-count assertion helper is worth
   reusing if one exists).
3. Identify the migration runner's test hooks, if any — some runners
   expose a way to run a migration's `up` then `down` in a test harness;
   use it instead of hand-rolling migration invocation in the test.

### Step 2: Plan test cases

**Queries:** the happy-path result set (values and ordering when the
query specifies `ORDER BY`), the empty-result case (a filter that matches
nothing), and the boundary case for any range condition — these are where
an off-by-one or a `JOIN` that should have been a `LEFT JOIN` surfaces.

**N+1 regression tests:** alongside the result assertion, assert the
query count didn't regress back to one-per-row — most ORMs/test harnesses
expose a query counter or a query log to assert against.

**Migrations:** the `up` path against a representative row count (not an
empty table), the `down` path when the migration states one (running
`up` then `down` should leave the schema equivalent to before), and
idempotency when the migration was written to tolerate re-application.

**Batched backfills:** a row count large enough to exercise at least two
batches, asserting every row was updated exactly once — no row skipped at
a batch boundary, none double-applied in a way that would corrupt a
non-idempotent update.

### Step 3: Write

1. Wrap each test in the project's transactional-rollback isolation (or
   its existing equivalent) per `rules/testing.mdc`; reserve a dedicated
   torn-down schema/database only for cases a transaction can't roll back
   cleanly (`CREATE INDEX CONCURRENTLY`, cross-transaction concurrency).
2. Build fixtures through the project's existing factory/helper, seeding
   only what the test needs, named descriptively
   (`user_with_expired_token`, not `test_user_3`).
3. Construct any "now"-relative fixture value from a fixed, injected
   reference time — never a live `NOW()`/`CURRENT_TIMESTAMP` evaluated at
   test-run time for a boundary case.
4. Assert on the query's actual rows/values/ordering, and on the query
   count for an N+1 regression test — never assert only "ran without
   error."

### Step 4: Run and fix

Run the project's own database test command. Fix failing tests (max 3
iterations) — fix the test or fixture, not the migration/query under
test, unless the test itself correctly caught a real bug (say so in the
report rather than silently changing the schema/query to make the test
pass).

### Step 5: Report

```
Generated: tests/migrations/test_add_status_backfill.py
  - Up/down path tested against a 50k-row fixture, 3 batch boundaries
  - Asserted every row updated exactly once, no row skipped or doubled
```

## Rules

- ALWAYS match the project's existing isolation and fixture conventions
  found in Step 1, not a different project's style.
- NEVER modify the migration/query under test — only test files and
  fixtures — unless the test caught a real bug (state that explicitly).
- NEVER assert only that a query "ran without error" — assert on its
  actual result rows/values/ordering.
- Test a migration's `up` path against a representative row count, not
  only an empty table.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The test just checks the migration doesn't throw, that's enough" | A migration that silently backfills the wrong value, or skips rows at a batch boundary, throws no error — only a result assertion catches that |
| "I'll seed with `NOW()` for the expiry fixture, it's close enough" | A live clock value makes boundary cases (a row that just expired) flaky depending on exact test-run timing; use a fixed reference time |
| "This N+1 fix already returns the right rows, that's the test" | A correct result set today doesn't prove the query count didn't regress back to one-per-row after a later change; assert the count too |
| "I'll test the migration against an empty table, it's faster" | An empty-table test can't catch a lock/lastingness/batch-boundary issue that only shows up at realistic row counts |

## Verification

Do not report the work done until all of the following hold:

- Every new/changed test runs isolated via the project's transactional
  (or equivalent) rollback strategy — no test leaves state for the next
  test to trip over.
- Every query test asserts on actual result rows/values/ordering, not
  merely "no error thrown."
- A migration test covers both the `up` path at a representative row
  count and, when the migration states one, the `down` path.
- `git status`/the diff shows only test and fixture files changed, unless
  a real bug in the migration/query was found and fixed (stated in the
  report).

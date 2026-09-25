# PR comment — backend

Use when the scope is backend and there is no frontend twin in this PR.
A fullstack or paired change uses `templates/pr-comment-frontend.md` instead,
and still records the wire contract there.

Skeleton: `templates/review-report.md`. Render a Verified-clean bullet only
if that check was actually run.

## Verified clean — render only what was checked

API and DTO

- The contract change is backward compatible, or the break is named and the
  consumer PR is linked with a deploy order.
- Input is validated at the boundary, not trusted from the caller.
- Error codes match what the client branches on.
- The frontend consumer was read, not assumed.

Data

- Migrations reverse, and the reverse was read against the volume they run on.
- New filters have an index, or the finding says why the scan is bounded.
- Writes that must be atomic sit in a transaction; the isolation level is the
  one the invariant needs.

Security

- Every new or changed endpoint checks authz, not only authentication.
- Queries are scoped to tenant / case / workspace.
- No string-built query, no secret in a log or a fixture.

Concurrency

- A retried command is idempotent, or the finding names the double-apply.
- Locks have a TTL and a heartbeat, or they are not locks.
- Retry has a bound and backpressure; a queue has a depth limit.
- Cache invalidation names the writer that was checked.

Tests

- The level matches the failure mode (unit for a branch, contract for a wire
  shape, integration for a transaction).
- A wire-format change has a contract test against the bytes, not the builder.
- A fix cites the test that failed before it and passes after it.

## Scope notes

Same as the frontend template: process remarks render under `### Scope` with
`location_class: pr-process`. They do not block on their own.

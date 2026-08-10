# Implementation Plan

Status: frozen approach pending implementation

## Approach

Keep search as pure data retrieval and build an explicit report projection/store
beside it. This is the smallest compatible split: all adapters receive the
existing ranked data without legacy report paths; only `--save-report` renders
and publishes a bounded report. A shared report store receives clock/run-ID
dependencies so collision, concurrency, and interrupted-publication behavior is
deterministic in tests.

## Steps

1. Update the P0 red tests and add report-store/CLI tests that define P1 behavior.
2. Remove report persistence and required paths from the service result, then
   migrate direct adapters/callers while retaining semantic fallback behavior.
3. Implement bounded DTO rendering plus schema validation and immutable atomic
   per-run report publication.
4. Wire CLI `--save-report`; leave default text/JSON output pure and stdout-only.
5. Prove all read surfaces with `KERYX_P0_ENFORCE=1`, focused tests, typecheck,
   and the appropriate broader checks; record any pre-existing external failure.

## Risks

- Atomic directory publication needs a safe unique-ID/collision strategy without
  introducing a P4 canonical-write seam.
- P0 characterizations must be converted to green expectations, never deleted or
  weakened.
- Runtime-root ignore policy is P2 scope; tests use temporary fixture roots and
  do not alter project Git policy in P1.

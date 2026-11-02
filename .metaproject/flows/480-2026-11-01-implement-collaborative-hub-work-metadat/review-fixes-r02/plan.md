# PR1113 round 2 fix plan

Version: 1.0

Resume Flow 480 at reviewed head d50652ac71030f955c94f84cc5c73589ecf7f02a. Original review package is read-only input. Fix confirmed major mechanisms with a failing regression before each implementation; avoid unrelated refactors. Preserve draft PR; no merge, release, or production deployment. Owner completes review rounds.

## Owner decisions

- Restore protection for safety backups younger than 14 days; align deployment documentation.
- Allow Flow-only amendments: empty affectedIntentIds is valid in API, UI, and all schemas.
- Uphold Attempt participant authorization defect SEC-W32-001 and live/demo receipt parity defect review-degradation-w8:F-002.
- Exclude refuted review-logic-w31:F-001 (Bun argv premise).

## Execution waves

1. Scoped storage/projections/contracts; UI events/forms; native execution queue and Attempt authorization. Coordinate shared files explicitly.
2. Git delivery recovery and request admission; operational backup/migration/help and deterministic packaging checks; finish cross-layer revisions pagination.
3. Integrated quality gate, mutation gap coverage, canonical finding disposition ledger, CI, and next review with prior r02 on the final head.

Each mechanism records finding IDs, red command/output, green regression names, changed files, and commit. Canonical findings count: 76 major, 171 minor, 26 info (273 total); report prose says 172 minor. Preserve canonical data and document discrepancy.

## State × event regression matrix

| State | Event | Required observation |
| --- | --- | --- |
| Native item reserved | transient admission/quota refusal | reservation remains retryable; original operation can later proceed |
| Native item observed | stale admission/version | machine event ingestion advances safely; no poisoned event transaction |
| Native item edited in place | remove with incremented version | same operation reservation is released exactly once |
| Amendment resolved | fresh operation re-resolves with current versions | rejected; accepted Intent and original resolution immutable |
| Flow/Intent projected | late incident Evidence | HTTP/SDK/UI closed contracts include supported incident and aggregates |
| Attempt owned by A | contribution from B or agent claiming human method | forbidden; no persisted changes |
| Delivery pending | process restart | uncertain job visible; explicit audited authorized reconciliation can resolve fence |
| Delivery externally succeeded | line changes or finalization authority changes | immutable external facts remain observable, retry never republishes |
| Tiny concurrent mutating requests | queue wait / nested MCP call | bounded fair admission based on actual retained bytes, no double charge |
| Unauthenticated request | indefinitely slow body | authentication/deadline limits resource occupation |
| Machine socket overloaded | queue busy | recoverable overload semantics, never false authorization-change reason |
| Overview without Work snapshot | record event page | no discarded per-record GET fan-out; attention invalidates |
| Snapshot load in flight | newer events merged first | load does not overwrite newer records or advance past unseen changes |
| Own command receipt partial | command changes related records | affected cache and attention converge without waiting for safety poll |
| New unapproved Intent | amendment approval | editable inclusion and complete expected-version manifest |
| Flow-only requirement change | affectedIntentIds empty | accepted consistently by UI, SDK, API and generated schemas |
| Cancelled required Intent | Flow summary | does not prevent eligible live Intent aggregate completion |
| Form draft / collapsed machine | choice changes / pending approval | latest selected value sent; pending approval remains visible |
| More than 50 revisions | first page and continuation / selected line | newest useful page, all pages reachable, exact selected line available |
| No managed execution work | frequent machine events | no scan/parse of unrelated historical session Work rows |
| Legacy state unchanged | read or unrelated remote frame | no repeated full legacy serialization/persistence |
| Legacy writer used during rollback | new-version startup | sessions and record projections match current canonical legacy state |
| Archived document exists / archive quota reached | idempotent replay or unrelated legacy mutation | no duplicate quota charge and no permanent unrelated-write blockade |
| More than three recent safety backups | prune | every backup younger than 14 days retained, referenced backup retained |
| Terminal native queue history exists | migrate apply readiness | terminal history does not count as unresolved execution |
| Work command nested help | CLI --help | Work-specific help appears through actual CLI entry point |
| Offline normal test run | packaging tests | no npm registry request; explicit network preparation is separate |

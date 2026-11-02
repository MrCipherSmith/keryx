# Round 2 finding dispositions
Version: 1.0

Full matrices and evidence: [dispositions.json](dispositions.json).

| Finding ID | Status | Commits | First regression; full matrix in JSON |
| --- | --- | --- | --- |
| review-architecture-w1:F-001 | fixed | fed10a161 | live overview events refresh attention without discarded per-record requests |
| review-architecture-w10:F-001 | fixed | 8d2a0eef9 | durable amendment resolution %s cannot be followed by %s under a fresh operation/version (4 matrix cases) |
| review-architecture-w2:F-001 | fixed | 8d2a0eef9 | durable amendment resolution %s cannot be followed by %s under a fresh operation/version (4 matrix cases) |
| review-architecture-w8:F-001 | fixed | 3173ac8e8 | safety backups retain every young copy plus the newest three and the explicit restore pointer |
| review-architecture-w9:F-001 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-backend-w10:BE-W10-001 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-backend-w2:F-001 | fixed | 8d2a0eef9 | durable amendment resolution %s cannot be followed by %s under a fresh operation/version (4 matrix cases) |
| review-backend-w2:F-002 | fixed | 6c692b107 | queued configuration drift retains its reservation and admits after native configuration recovery |
| review-backend-w3:F-001 | fixed | a0e20ad7f, da9ee774e | live attention Evidence response satisfies the closed API schema and Work client |
| review-backend-w7:F-001 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-backend-w7:F-002 | fixed | b56f115bf, a856efcff | revision browser follows opaque continuation and opens an exact deep link outside the first fifty |
| review-backend-w7:F-003 | fixed | b3d94fc4d, 2aadf1165 | WebSocket mutation lane full uses recoverable overload rather than authorization loss |
| review-backend-w7:F-004 | fixed | 6c692b107 | queued configuration drift retains its reservation and admits after native configuration recovery |
| review-backend-w8:F-001 | fixed | 8d2a0eef9 | durable amendment resolution %s cannot be followed by %s under a fresh operation/version (4 matrix cases) |
| review-clean-code-w10:F-001 | fixed | a0e20ad7f | live capabilities expose the published closed limit contract to the Work client |
| review-clean-code-w7:F-001 | fixed | 23a11ba5f | full docs/requirements/hub-work-management/verify.cjs |
| review-degradation-w1:F-001 | fixed | fed10a161 | matching live events still invalidate attention after a receipt already merged the version |
| review-degradation-w10:F-001 | fixed | 3173ac8e8 | safety backups retain every young copy plus the newest three and the explicit restore pointer |
| review-degradation-w11:F-001 | fixed | b3d94fc4d, 2aadf1165 | WebSocket mutation lane full uses recoverable overload rather than authorization loss |
| review-degradation-w13:F-001 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-degradation-w13:F-002 | fixed | 6c692b107, f7c0f1a06 | managed queue quota failure rolls back native allocation and retries the same queued operation |
| review-degradation-w14:F-001 | fixed | 8d2a0eef9 | durable amendment resolution %s cannot be followed by %s under a fresh operation/version (4 matrix cases) |
| review-degradation-w15:F-001 | fixed | de89c8f74 | optional legacy archival cannot block unrelated writes while immutable pin quota stays strict; live legacy import remains writable at optional document archive capacity with Work disabled |
| review-degradation-w15:F-002 | fixed | ced30a751 | rollback writer changes rebuild legacy and session projections on reupgrade |
| review-degradation-w16:F-001 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-degradation-w16:F-002 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-degradation-w2:DEG-R2-W2-001 | fixed | 6c692b107 | queued configuration drift retains its reservation and admits after native configuration recovery |
| review-degradation-w7:F-001 | fixed | 69e9e91ef | live membership amendment includes a newly introduced unapproved Intent and its editable proposal target |
| review-degradation-w7:F-002 | fixed | 69e9e91ef | live membership amendment includes a newly introduced unapproved Intent and its editable proposal target |
| review-degradation-w8:F-001 | fixed | fed10a161 | live-shaped decision-only receipt immediately reconciles related Intent state without waiting for idle polling |
| review-frontend-w1:F-001 | fixed | f0e2fe1d7 | collapsed machine sessions expose active-run approval attention without loading routing details |
| review-frontend-w1:F-002 | fixed | fed10a161 | live retention-gap resync refreshes attention and observations while exact documents stay immutable |
| review-frontend-w3:F-001 | fixed | fed10a161 | slow live snapshot refresh cannot overwrite a newer event already applied to the board |
| review-highload-w1:HL-R2-001 | fixed | fed10a161 | live overview events refresh attention without discarded per-record requests |
| review-highload-w2:HL-R2-001 | fixed | 0c212c7ac | reconcileSession with no pending managed reservations performs zero remote history reads |
| review-highload-w7:HL-R2-W7-001 | fixed | 3173ac8e8 | safety backups retain every young copy plus the newest three and the explicit restore pointer |
| review-highload-w8:HL-W8-001 | fixed | b3d94fc4d | WebSocket mutation lane full uses recoverable overload rather than authorization loss |
| review-highload-w8:HL-W8-002 | fixed | b3d94fc4d, 2aadf1165 | WebSocket mutation lane full uses recoverable overload rather than authorization loss |
| review-highload-w8:HL-W8-003 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-highload-w9:HL-W9-001 | fixed | 3e01c2c8e | legacy reads do not serialize history and remote-only transactions do not materialize it; lazy legacy transactions roll back changes and preserve optimistic concurrency; returning the lazy transaction state preserves its original snapshot boundary; async legacy callback is refused and its synchronous changes roll back |
| review-highload-w9:HL-W9-002 | fixed | 0c212c7ac, 3e01c2c8e | reconcileSession with no pending managed reservations performs zero remote history reads |
| review-logic-w1:F-001 | fixed | f0e2fe1d7 | collapsed machine sessions expose active-run approval attention without loading routing details |
| review-logic-w11:F-001 | fixed | bf459556a, 4759009a1 | MigrationSafety.test_queue_history_only_blocks_adoption_when_unsettled |
| review-logic-w2:F-001 | fixed | 6c692b107 | queued configuration drift retains its reservation and admits after native configuration recovery |
| review-logic-w2:F-002 | fixed | 6c692b107, f7c0f1a06 | managed queue quota failure rolls back native allocation and retries the same queued operation |
| review-logic-w23:F-001 | fixed | 58502381a | main CLI routes managed Work help for root and deep --help without credentials or network |
| review-logic-w24:F-001 | fixed | a0e20ad7f, da9ee774e | live attention Evidence response satisfies the closed API schema and Work client |
| review-logic-w29:F-001 | fixed | 69e9e91ef | live membership amendment includes a newly introduced unapproved Intent and its editable proposal target |
| review-logic-w30:F-001 | fixed | 69e9e91ef | live membership amendment includes a newly introduced unapproved Intent and its editable proposal target |
| review-logic-w30:F-002 | fixed | fed10a161 | slow live snapshot refresh cannot overwrite a newer event already applied to the board |
| review-logic-w31:F-001 | excluded-refuted |  | Verifier refuted Bun argv premise |
| review-logic-w35:F-001 | fixed | b56f115bf, a856efcff | revision browser follows opaque continuation and opens an exact deep link outside the first fifty |
| review-logic-w35:F-002 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-logic-w36:F-001 | fixed | 6c692b107 | queued configuration drift retains its reservation and admits after native configuration recovery |
| review-logic-w37:F-001 | fixed | d4365bc09 | live Flow and Intent aggregates expose a late contradictory Evidence incident from indexed persistence; many incidents on one Attempt load its support once and overflow aggregates fail within a bounded incident page |
| review-logic-w38:F-001 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-logic-w38:F-002 | fixed | ced30a751 | rollback writer changes rebuild legacy and session projections on reupgrade |
| review-logic-w6:F-001 | fixed | 868c48f34 | live Evidence submits the visible current option when the saved subject no longer exists |
| review-performance-w1:F-001 | fixed | fed10a161 | live overview events refresh attention without discarded per-record requests |
| review-performance-w1:F-002 | fixed | f0e2fe1d7 | collapsed machine sessions expose active-run approval attention without loading routing details |
| review-performance-w4:PERF-W4-001 | fixed | fed10a161 | live overview events refresh attention without discarded per-record requests |
| review-performance-w8:F-001 | fixed | b3d94fc4d, 2aadf1165 | WebSocket mutation lane full uses recoverable overload rather than authorization loss |
| review-performance-w9:F-001 | fixed | 0c212c7ac | reconcileSession with no pending managed reservations performs zero remote history reads |
| review-performance-w9:F-002 | fixed | 3e01c2c8e | legacy reads do not serialize history and remote-only transactions do not materialize it; lazy legacy transactions roll back changes and preserve optimistic concurrency; returning the lazy transaction state preserves its original snapshot boundary; async legacy callback is refused and its synchronous changes roll back |
| review-regression-w2:F-001 | fixed | 6c692b107 | queued configuration drift retains its reservation and admits after native configuration recovery |
| review-regression-w5:F-001 | fixed | 69e9e91ef | live membership amendment includes a newly introduced unapproved Intent and its editable proposal target |
| review-regression-w8:F-001 | fixed | 3173ac8e8 | safety backups retain every young copy plus the newest three and the explicit restore pointer |
| review-regression-w9:F-001 | fixed | b56f115bf, a856efcff | revision browser follows opaque continuation and opens an exact deep link outside the first fifty |
| review-security-code-w31:SEC-W31-001 | fixed | b3d94fc4d, 2aadf1165 | WebSocket mutation lane full uses recoverable overload rather than authorization loss |
| review-security-code-w32:SEC-W32-001 | fixed | b66c96421 | < |
| review-style-w10:F-001 | fixed | 3173ac8e8 | safety backups retain every young copy plus the newest three and the explicit restore pointer |
| review-style-w10:F-002 | fixed | 23a11ba5f | full docs/requirements/hub-work-management/verify.cjs |
| review-testing-practices-w1:F-001 | fixed | 69e9e91ef | live membership amendment includes a newly introduced unapproved Intent and its editable proposal target |
| review-testing-practices-w1:F-003 | fixed | 86a949af3 | missing isolated runtime cache is refused before any installer can use the network or host caches |
| review-testing-practices-w5:F-001 | fixed | 771c8a27e | external Git delivery never holds the global mutation queue and same-key retry never starts it twice |
| review-testing-practices-w6:F-001 | fixed | a0e20ad7f, da9ee774e | live attention Evidence response satisfies the closed API schema and Work client |

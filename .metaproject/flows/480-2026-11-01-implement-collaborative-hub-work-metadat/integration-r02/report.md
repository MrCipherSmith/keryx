# Integrated round 2 candidate
Version: 1.0

The normal merge9a0f4641efc9c4b3c70822637e7b420d9427ba3d retains both histories: remote8dcb765f072c5e8cb287175af7d7c9ce300ce322 and candidate33ef4c0f11dae9e0f48fd1dbf02c0c70a3eff104. No force-push or main merge. The common reviewed source is d50652ac71030f955c94f84cc5c73589ecf7f02a.

## Selected behavior

- Candidate delivery recovery/CAS/reason/audit/cold archive and uncertain-push handling, bounded actual-byte/root-ALS admission/auth-first/native1013 replay, indexed managed lineage, lazy prepared legacy transactions and strict optional-vs-pinned document archival.
- Remote simpler digest projection initialization, lightweight Work help, useful positive participant/session/schema/browser-adapter tests, demo side-effect events with shared polling and actual SDK pagination assertions.
- Candidate Evidence Overview resolution, persistent draft submit filtering, all-consumer revision paging and cache resync/own-receipt safeguards.
- Both meaningful test collections retained. Obsolete duplicate helper implementations and unreleased retry/abandon expectations are explicitly accounted for in the owner ledgers below, not silently counted as preserved guarantees.

## Integration repairs

Recovery and archive routes retain the remote transport's exact idempotency guarantee: identical actor/path/key/body returns the original response after reauthorization; changed payload409, revoked identity401, agents403. Receipts are persisted atomically with job CAS/archival in the same SQLite transaction. Fault-injection rollback and one-inspection-only replay are tested. Original delivery result replay remains intact.

A real CI failure in both old remote jobs was reproduced locally: a root test imported the browser adapter and undeclared UI-only i18next. Commit676783e55 moved the meaningful actual production createWorkHttp→liveWorkAdapter assertion into hub-web Vitest. Root real SQLite/schema/WorkClient assertions remain; no dependency or NODE_PATH workaround was added. Root tests pass with UI dependencies absent, and the UI suite now has198 tests. This is a test-location change only; product code remains the integrated merge tree.

## Evidence and next steps

- [Storage/ops choices and adapted assertions](storage-results.md)
- [Delivery/native/admission choices and adapted assertions](native-results.md)
- [UI/MCP choices and adapted assertions](ui-results.md)
- [Real CI failure triage](old-ci-triage.md)
- [Root/UI dependency boundary RED→GREEN](ci-boundary-results.md)
- [Independent final verification](final-verification.md)
- [Original failed integration gate](pre-boundary-fix-verification.md)

The per-ID round2 ledger remains in ../review-fixes-r02/dispositions.json; those root-cause commits are retained as ancestors. This report and the independent integration gate supersede the standalone candidate's validation claims for the combined product.

GitHub checks on the final pushed PR head determine CI readiness. PR remains Draft. No release, production deployment, acceptance, review-round completion or merge into main is automated. The owner retains final review/merge authority.

Routing: graph_used=yes (explicit rebuild after merge), wiki_used=yes, ctx_used=yes, raw_rg_used=no. Source comparison used exact pinned Git objects where no remote-tree graph existed.

## Independent final gate

Verified source676783e55e01468fd1fdd7021ffbbad41cbdeae6. PASS_WITH_WARNINGS:452strict changed tests,0failures,454total with1intentional separately-exercised integration skip and1existing rewind TODO;534Hub tests/7745assertions;198UI tests; actual frozen offline package/runtime9tests/61assertions. Strict, Hub and extracted-runtime checks ran with UI dependency link absent, without dependency injection/install. UI/types/lint/assets, scripts types, Python migration14/boundaries29/profile5, shell and docs checks passed. Only metadata/report commits follow this source; final GitHub checks remain authoritative for publication readiness.

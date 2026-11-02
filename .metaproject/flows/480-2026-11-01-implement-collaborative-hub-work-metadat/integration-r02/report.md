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

## CI cache portability follow-up

Commit `7f32cc739b52d1567bd1431afd2274434afc6d07` fixes the only failed published integration check: Bun1.4.4 keys cache metadata by registry identity, so a loopback registry override made all prepared pins appear absent. The installer now preserves registry identity and uses a rejecting local TCP proxy with both bypass variants cleared. CI explicitly prepares cache/pulls the matching image, then executes the extracted proof with `--pull=never --network none`, readonly mounts and UID1001 without overriding HOME. Ordinary tests still perform no network preparation.

Mac Bun1.3.14/1.4.4 each passed10package tests; Linux both versions passed actual extracted offline SDK proof with no container network, including exact UID1001 commands (1test/7assertions each). Ordinary network-denied gate passed9tests with1explicit integration skip; lint/scripts types passed. Production backend/frontend source was unchanged. [Exact RED/GREEN matrix and commands](cache-ci-results.md).

## Exact CI typecheck correction

On published9dc913fc, distribution succeeded but root CI typecheck reported TS2783 for deliberate duplicate proxy-bypass keys in the test. The prior scripts-only cache verification did not establish root typecheck compatibility. T43 reproduced exact `bun run typecheck` RED and replaced the initializer with Object.assign, retaining wildcard inherited values and both empty-value assertions. Exact root/scripts typechecks, targeted lint and the guard regression (1pass/9assertions) now pass. No application, helper, cache or workflow changes. [Exact RED/GREEN evidence](ts-ci-results.md). Final PR-head CI remains authoritative.

## Deterministic controller fixture race

On a862a0a3e, all19otherchecks passed (including completeAC8 and distribution; Pages deployment skipped), while root core had27785pass/1failure in the mixed queue controller-generation test. T44 deterministically held a real SessionRecord GET across an actual applied native release: the unchanged fixture sent stale CAS pins and failed409 at the same controller claim assertion. Only the test client now refreshes exact stale-version responses, bounded to4attempts. Genuine authority conflicts still fail immediately. Three explicit network regressions and93relatedtests/7775assertions passed with1existingTODO, root/scripts types and lint green. No product source changes or whole-test retry. [Exact RED/GREEN evidence](queue-ci-results.md). Final new-head CI remains required.

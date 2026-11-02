# T38 integration: delivery, native queue and admission

Owned paths are frozen; no staging/commit/push performed. Root resolves index after all workers finish.

- Owner-approved candidate delivery service, CAS/reason/audit, cold archive, uncertain push, read-only inspection preserved together
- Remote marker-idempotency already present candidate and actual Git replay test preserved
- Selected-line drift retains external fact with409 externalResult; obsolete lineChanged success field removed
- Native guard refusal never releases managed reservation; terminal native facts own release; indexed managed lineage preserved
- Actual-chunk accounting, nested root slot/abort/inner bytes, auth-before-body, bounded WebSocket1013 and actual TCP cleanup preserved
- Remote frame-admission test retained and adapted to assert no unbounded internal bypass
- Remote recovery meaningful assertions adapted to delivery-jobs reconcile contract, including departed-original-actor and same-key replay
- Preserved same-key recovery/archive response guarantee with atomically persisted receipts, current auth before replay, changed payload409, no extra inspector/Git/archive

## Verification

- Actual combined focused regression: 85 passed, zero failed, 883 assertions, 13 files. Raw: `.metaproject/data/gdctx/raw/2026-11-02T05-46-31-393Z-f6ad14_run.log`.
- Includes real TCP MCP cleanup, Git lost-push reply, actual SQLite scoped reconciliation, native queue reservations, role checks, snapshots/review bundles and exact revision summaries.
- Adapted remote recovery assertions exposed repeated-key409, reproduced with two failing HTTP cases before repair. Raw: `.metaproject/data/gdctx/raw/2026-11-02T05-43-29-147Z-49dd61_run.log`. Both now pass; unchanged-key exact response, changed-key digest conflict, revoked/agent credentials denied, no second inspect, and atomic before-commit rollback tested.
- Final lint PASS. Global types PASS on final frozen source (`05-49-48-964Z-f5ee82`); final lint PASS (`05-49-38-106Z-3d7e0a`) and all-owned-path diff-check PASS (`05-49-56-111Z-0b5f14`).

## Superseded assertions / intentional choices

- **delivery-queue line drift200+lineChanged** → candidate409+externalResult, durable Delivery fact, newer selected line unchanged; existing delivery completion test
- **resolve action retry invokes adapter after interruption** → chosen inspect-publication exact original marker proves publication without second push; actual Git HTTP test and inspector receipt counter
- **resolve action abandon plus delivery-abandoned event** → confirm-no-effect exact CAS/reason and persisted reconciliation audit plus original delivery-no-effect replay; adapted remote recovery test preserves fence exit and role checks
- **same-key resolve repeat returns200** → preserved, atomic recovery receipt; RED thenGREEN; changed body409 and revoked auth denied
- **definitive pre-admission refusal releases reservation** → explicit owner-selected terminal-fact-only policy; native configuration recovery test and retained reservation tests
- **frame serialization uses internal:true to bypass capacity** → retained test now asserts no bypass; real full/expired queue regressions assert1013
- **fake-clock scheduling/declared reservation/exemption implementation assertions** → deadline, actual aggregate capacity, small concurrency, cancellation/nested semantics preserved by candidate actual behavior tests; no fake clock API added or internal-unbounded policy retained
- **zero pending reads, queue read once** → candidate zero pending reads plus stronger indexed relevant-lineage/cold-history test
- **native in-place edit/removal, replacement edit and released edit** → candidate real network matrix tests preserved and pass for reserved/released plus in-place remove

## Paths

- `src/hub/delivery-service.ts`
- `src/hub/delivery-jobs.ts`
- `src/hub/git-delivery.ts`
- `src/hub/domain.ts`
- `src/hub/server.ts`
- `src/hub/contracts.ts`
- `src/hub/revision-summary.test.ts`
- `src/hub/review-bundle.test.ts`
- `src/hub/delivery-queue.test.ts`
- `src/hub/mutation-queue.ts`
- `src/hub/mutation-queue.test.ts`
- `src/hub/mutation-queue.http.test.ts`
- `src/hub/remote-v2/index.ts`
- `src/hub/remote-v2/queue.ts`
- `src/hub/remote-v2/sessions.ts`
- `src/hub/remote-v2/managed-execution.ts`
- `src/hub/remote-v2/storage.ts`
- `src/hub/work/execution.ts`
- `src/hub/work/execution.test.ts`
- `docs/requirements/hub-work-management/execution.md`
- `docs/requirements/hub-work-management/delivery-recovery.md`
- `src/hub/remote-v2/frame-admission.test.ts`
- `src/hub/work/legacy.test.ts`
- `docs/requirements/team-hub-prototype/api.md`

Routing: graph stale during merge, known exact paths; wiki/testing context read; ctx used; no bare rg. Original review packages unchanged.

Final receipt-order followup: same-key invalid changed bodies reproduced400 instead of409 in two cases (`05-48-29-973Z-cfeadb`). Validation now occurs after current-authorized replay lookup;14 delivery tests119assertions PASS (`05-48-37-398Z-8a2c79`), final delta lint PASS (`05-48-38-376Z-23b86f`).

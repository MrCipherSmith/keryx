STATUS: DONE

# Independent reload recovery review

Final verdict: APPROVE after the narrow R-001 repair. One major was independently reproduced and then fixed; no unresolved actionable findings remain.

## R-001 — Current retry refusal erases the original unknown outcome (fixed)

- Severity: major.
- Anchors: `apps/hub-web/src/features/managed-work/operation.tsx:68` and `apps/hub-web/src/features/remote/work.tsx:144`.
- Trigger: the server commits an original mutation but its response is lost; the caller explicitly retries the original operation after current authorization/lease/project conditions change. The retry receives a 4xx before the server reaches the original receipt. For example, the work domain rejects a read-only actor before its idempotent receipt lookup.
- Result: Work classifies the retry as a definite refusal and deletes the persisted original command. Native retry likewise clears the original envelope for a non-ambiguous 4xx. A current request refusal cannot establish whether the earlier request committed. The client loses the identity it needs to reconcile that earlier request and can later create a new operation.
- Fix: distinguish initial submission errors from retry errors after an uncertain outcome. Retain unknown and the original frozen envelope on every retry error unless an authoritative terminal result proves the original outcome. Keep current authority checks; do not automatically execute anything.
- Independent reproduction: `apps/hub-web/node_modules/.bin/vitest run --config output/work-ui-recovery-probe.config.mjs`. The probe first receives a lost response, then a retry403 `read-only`; its assertion that readPending still contains the original fails with actual null. Evidence: `.metaproject/data/gdctx/raw/2026-11-01T12-57-10-817Z-32d0c5_run.log`.

## Checked scope

Read the new bounded sessionStorage helper, Work operation integration, native persisted-envelope validator and composer integration, App auth clearing, new recovery tests and native reload tests. Verified stored requests restore unknown from a fresh in-memory store without automatic read or write; explicit lookup404 retains the original and explicit retry preserves its exact original UUID/body. Native storage binds current principal/project/session and exact message path, paired Attempt headers, consent and controller body. Reload does not copy the old original into an ordinary new draft. Auth reset clears in-memory drafts and the private storage prefix.

Storage schemas are closed; malformed/oversized entries and storage write denial block mutations. Per-entry/total/count bounds prevent unlimited retained requests. Current generated Attempt IDs are UUIDs; the persisted native validator's narrower ID regex does not reject any reachable generated Attempt ID, so no separate finding is reported for that theoretical contract difference. The helper permits same-operation-ID envelope replacement, but reviewed production callers retain frozen originals; no reachable different-body replacement was found.

Executed regression subset: `npm --prefix apps/hub-web test -- pending-recovery managed-native-message managed-work auth.case client.case drafts.case`: 8 files, 56 tests passed. These supplied tests omit the retry403 uncertainty regression above. Log: `.metaproject/data/gdctx/raw/2026-11-01T12-56-02-648Z-5f16f6_run.log`.

No production edits, credentials, installs, commits or deployment. Only an independent failing probe/config and this report were written under output. No fresh live-browser replay was performed in this pass.

Routing audit: graph_used: yes in the initial review, known stale and not relied on as current proof; wiki_used: yes in the initial review, no managed-work page; ctx_used: yes; raw_rg_used: no. Local guidance/testing context reused.

## Final fix verification

Work now treats only a first submission4xx as a definite refusal; lookup and explicit original retry errors retain the original unknown command. Native marks the retry path previously uncertain, retaining its original envelope on every error; authoritative queued/admitted/rejected receipts still settle the original. The retry button passes that flag explicitly. Neither change grants controller/actor authority or triggers automatic replay.

The independent regression above now passes unchanged: `.metaproject/data/gdctx/raw/2026-11-01T12-58-58-101Z-dfe8d8_run.log`. A narrow rerun of `npm --prefix apps/hub-web test -- pending-recovery managed-native-message` passes15/15, including permanent Work/native retry403 negative tests and printable Attempt-ID validation: `.metaproject/data/gdctx/raw/2026-11-01T12-59-05-090Z-8dcd08_run.log`. No broad gates were repeated after this catch-path-only repair.

Additional source audit: auth-loss increments generation before clearing persistence, preventing old in-flight callbacks from restoring envelopes. Original scope setters remain captured across project/session navigation. Unresolved native operations block new submissions regardless of mode, and retry remains disabled without an active human controller. Shared pending hooks use the same scoped draft state; persistent different-operation replacement is rejected, and storage failure returns before transport. No additional actionable defect was found in these paths. The native Attempt-ID decoder now aligns with printable ASCII Work headers while retaining closed envelope/body validation.

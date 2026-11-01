STATUS: DONE

# Independent final backend delta review

Verdict: **APPROVE**. No actionable blocker, major or minor findings in this delta. Prior backend review approval remains applicable to unchanged paths.

Reviewed the actual working changes to `src/hub/work/domain.ts`, `domain.test.ts`, `http.ts`, and `http.test.ts` after approved baseline `239ba7229`. HEAD observed during this pass: `466980d0a2b85a3e06a142de48bf793ad847be6f`; this review includes the uncommitted four-file delta, not merely that commit.

## Membership recovery

- New Intent creation requires an open parent Flow and creates only an unapproved draft. It does not change frozen FlowRevision membership, existing approved Intent pins, selected submission or acceptance.
- The append-order guard prevents initial approval of an Intent introduced after the first Flow approval. Inspected SQLite load/save ordering: records load by rowid, existing rows update without replacing their rowid, new rows append. This preserves the temporal premise used by the guard across normal persistence.
- New required membership must appear in an exact replacement FlowRevision within the same human amendment. Replacement ownership/current-revision/digest checks and whole-set dependent-Intent checks remain in effect.
- Flow start and aggregate acceptance use the approved revision's frozen requiredIntentIds. Merely creating a draft with required:true cannot inject a new requirement into accepted work or satisfy existing criterion coverage. Starting still requires approved exact parent pins, nonempty membership, CAS and complete criterion mapping.
- Inspected tests for empty-ready Flow recovery through FR2/IR2 and whole-set human approval, forbidden independent approval/Intent-only amendment, active accepted-work preservation, terminal parent refusal and draft required flags remaining outside existing membership.

## Snapshot quota and cursor retention

- Single-page exports return directly without retaining a Map entry while preserving the per-export byte bound and event cursor.
- A completed multi-page export removes its retained entry and decrements its exact byte count. Consumption occurs synchronously after scoped cursor validation; repeated completion cannot double-release quota because the retained entry is already absent.
- Unfinished exports retain the existing count, aggregate-byte, expiry and principal/project-scope limits. Cross-scope refusal occurs before deletion. Completed cursor reuse intentionally returns 410 as specified for this change; the event cursor still identifies the original immutable snapshot.
- Inspected assertions for 100 single-page refreshes, 100 completed multi-page exports, 32 unfinished exports, the 33rd refusal, cross-principal/project refusal without consumption, terminal consumption and reclaimed quota.

## Independent validation

Executed:

`bun test src/hub/work/domain.test.ts src/hub/work/http.test.ts src/hub/work/execution.test.ts src/hub/work/storage.test.ts`

**56 passed, 0 failed, 1080 assertions across 4 files.** This also reran the earlier queued unknown-execution regression, exact historical document retrieval, transaction rollback, cross-project storage refusal, immutable reservations and historical acceptance/remediation tests.

Raw evidence: `.metaproject/data/gdctx/raw/2026-11-01T11-12-04-984Z-d7a841_run.log`. No production edits, live provider calls or credentials used. This narrow approval does not replace the root's frontend, full-suite or final lint/type gates.

Routing audit: graph_used=prior affected-domain graph for navigation only; no new discovery needed for the explicit four-file delta and graph is not proof of live changes; wiki_used=prior index/spec context retained; ctx_used=targeted diff/read/run summaries and saved raw test evidence; raw_rg_used=no.

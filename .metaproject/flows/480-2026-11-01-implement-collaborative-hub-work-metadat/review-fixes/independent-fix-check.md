# Independent check of PR1113 fixes

Scope: incremental Work state loading/persistence, command-handler extraction, and managed native queue admission. Reviewed checkout: `<review-fix-worktree>`; committed head at first verification: `05e1a81937e5ca18c1acc7f4e77f625da8626a4a`. The F integration was still being developed, so its final frozen state requires recheck. The normalized legacy/indexed-authority work is also pending its owner's freeze.

## Result: PASS after independently reproducing and verifying fixes for two major defects and one minor defect

### IF-001 — major, resolved on recheck: failed Work save left an unlinked live native run

- `src/hub/remote-v2/queue.ts:57`: `drainSessionQueue` catches `HubFailure` after attempting admission, invokes refusal handling and returns, allowing the surrounding transaction to commit.
- `src/hub/remote-v2/sessions.ts:115`: `admitMessage` persists a native command and run before invoking the Work `admitted` hook at117.
- `src/hub/work/execution.ts:201`: that hook binds the reservation before creating/saving the Work execution link. A durable Work quota failure rolls back its nested Work save but does not roll back the earlier native command/run and reservation changes.

Reproduction uses the actual HTTP, WebSocket machine and delayed queue fixture. Before idle queue drain, force `hub_work_usage.records=100000` for the fixture project. Native peer receives a run command, but the Attempt has zero execution links. After restoring the fixture quota and reporting progress, the Attempt refreshes to `executionOutcome: none` while GET of the native run still reports `dispatching`.

Evidence:

- `/tmp/pr1113-delayed-admission.test.ts` — safety expectation fails (expected one link, actual zero after real native delivery).
- `.metaproject/data/gdctx/raw/2026-11-01T19-44-45-781Z-fb0832_run.log` — failing reproduction.
- `/tmp/pr1113-delayed-admission-impact.test.ts` —46 assertions confirm the inconsistent `none` Attempt versus `dispatching` run.
- `.metaproject/data/gdctx/raw/2026-11-01T19-45-23-205Z-921986_run.log` — impact proof.

Required fix: execute the entire delayed admission inside an atomic savepoint that rolls back command, run, reservation and Work mutation before handling refusal. Preserve the original queue identity and avoid leaving mutated in-memory session/machine values that a later step could save. Add a permanent quota-failure regression test proving that no unlinked native command/run can survive. The F owner and root were notified; this reviewer made no production changes.

Recheck: the F owner added a nested SQLite savepoint around the entire native admission, proposed clones for mutable row/head/operation values, and a recursively read-only lazy legacy state view. The permanent test `managed queue quota failure rolls back native allocation and permits a later fresh dispatch` asserts unchanged command/run counts, Hub sequence and session pending state, a released unbound reservation, no native command delivery or Work link, and a successful later fresh dispatch. Independently rerunning execution, admission-state and scoped lifecycle cases passed20 tests/525 assertions: `.metaproject/data/gdctx/raw/2026-11-01T19-49-17-666Z-0c06f4_run.log`. No additional F boundary defect was found. Final commit SHA will be supplied by the owner.

### IF-002 — major, resolved on recheck: normalization changed a valid original revision response on replay

The legacy upload validator accepts valid padded base64 aliases such as `YQ==` and `YR==`, which decode to the same byte `a`. The normalized blob table deduplicates on decoded `contentDigest` and stores only the first encoded representation. `metadataRevision` removes the original representation and hydration restores that first encoding for every file with the same digest.

Actual HTTP reproduction: create a `YQ==` revision, then create a `YR==` revision under another operation key. The second creation returns `YR==`; replaying that same request/key returns `YQ==`. The decoded artifact bytes remain equal, but the original immutable response is no longer exact. A valid pre-migration history containing both representations would also change its canonical replay fingerprint and block adoption.

Evidence: `/tmp/pr1113-base64-replay.test.ts`; `.metaproject/data/gdctx/raw/2026-11-01T19-51-27-105Z-7eacad_run.log`. A owner/root notified; no production changes from reviewer. Preserve exact original encoded representation (including existing v3 receipts) while deduplicating bytes, then add the permanent exact replay/migration regression case.

IF-002 recheck: the owner now keys blobs by the exact encoded representation and retains a hidden per-file `blobDigest` in persisted metadata. Wire responses still contain only original revision fields; hydration verifies both encoded and decoded digests. The same external HTTP reproduction now passes, alongside the five artifact storage/migration/quota tests (six tests/33 assertions): `.metaproject/data/gdctx/raw/2026-11-01T19-52-57-877Z-bf4d5e_run.log`. A permanent inline-alias migration regression is being added by the owner.

The normalized authority/format review also verified that initial archive quota allowances are gated by the `legacy-artifacts-v1` marker, so migration can preserve existing history before quotas apply to new writes. Artifact migration and writer4 fence are committed in one transaction; the captured prior writer3 startup gate refuses writer4, and failure rolls back inline data/fence. Blob getters stay lazy through metadata serialization, baseline checks and ordinary native/Work admission.

## Checks that passed

Seven additional existing domain scenarios were replayed through the actual SQLite `commandState`/delta-save fixture, covering full acceptance, late evidence, whole replacement amendments, stale amendment CAS, historical accepted evidence/remediation, and cancelled Intent membership removal. All seven passed (34 assertions).

At the root's request these are now portable CI tests in `src/hub/work/storage.scenarios.test.ts`, sharing `storage.fixture.test-support.ts` with the existing lifecycle tests. Existing and new suites:10 tests/44 assertions passed, and ESLint passed for all three test/support files. They were committed separately as `3b96dc73d`. The reviewed final handler decomposition was committed as `21778d09c`.

Evidence: `.metaproject/data/gdctx/raw/2026-11-01T19-42-30-357Z-d44bea_run.log`, `.metaproject/data/gdctx/raw/2026-11-01T19-42-31-058Z-cfa7a0_run.log`.

Read-only inspection also checked:

- command-specific closure loading for all command families, required membership and unresolved amendments;
- exact subject/evidence/submission/decision pins and actor-scoped idempotency receipts;
- project predicates on scoped storage queries and authorization before partial reads;
- record/operation byte/count accounting inside the SQLite save transaction;
- monotonic event cursor persistence and410 resync for pruned history;
- index-backed record lookups and handler helper ownership after extraction.

No additional reproducible defect was found in those committed Work paths. The final owner checks/commit hashes and permanent alias migration case should be recorded before release. No additional reproducible correctness/security regression was found in this scoped audit.

Routing audit: graph used (reported stale/new-file changes, not treated as current), wiki previously read, testing context/local review-logic and ctx used; raw rg not used. Original review package remained read-only.

## Reservation orphan recovery contract

The F owner confirmed the operator recovery path deliberately reuses human `close-session` followed by an accepted native `closedProof` for an unbound ambiguous reservation. Missing queue/run rows alone do not prove cessation and do not release it. Bound unknown allocations still require native confirmed-cessation reconciliation. No standalone release button or agent assurance grants permission. This behavior is documented in the execution documentation and F ledger.

## Final normalization checks

- Prior-writer fixture provenance independently verified: `git show c1c29b04dacd96360e394bfa8a4ea5c7cf06abcb:src/hub/remote-v2/storage.ts` hashes to `3643d64b63c21ce2b33735bca5cd2977966ff25ccf3b265570a33924172b4de3`. The fixture is exactly that production migration prefix after removal of the documented unused budgets import, not a reimplemented gate.
- Permanent exact encoding read/replay/restart and existing inline alias migration cases pass. Independent artifact suite plus original external replay reproducer:8 tests/44 assertions, `.metaproject/data/gdctx/raw/2026-11-01T19-57-16-334Z-d7b58e_run.log`.
- Running the migration Python suite during the root's separate deployment-profile change currently fails two argv fixtures because the new required profile argument is absent. Root notified; this is in-flight integration drift rather than a normalization defect.

### IF-003 — minor, resolved on recheck: response quota excluded revision metadata

`hubRead` sums only `contentBase64` lengths for the32MiB revision-page response cap. Eight valid-shaped revisions with5000 empty files and roughly965-character paths produce a JSON response above32MiB while the entire legacy aggregate remains below64MiB, but the read succeeds because encoded content bytes total zero.

Reproducer: `/tmp/pr1113-revision-response-cap.test.ts`; bounded failing evidence `.metaproject/data/gdctx/raw/2026-11-01T19-59-24-459Z-4f3d6a_run.log`. Owner/root notified. Count the full serialized response (or explicitly make the policy binary-only with a separate envelope bound).

### Explicit residual for carry-over F-002

Normal managed Work commands/read projections now use scoped indexed rows and incremental persistence. Legacy v1 metadata intentionally remains a bounded aggregate up to64MiB and its writes still serialize that metadata aggregate. Binary revision payloads are normalized separately (512MiB encoded blob quota), immutable document archives have their own512MiB/record quota, and transient event/document delta windows expire. Accepted artifacts and receipts are not silently pruned. Therefore the original whole-legacy-aggregate mechanism is only partially removed; the PR must explicitly state this compatibility residual and archival requirement instead of marking the entire carry-over F-002 mechanism eliminated.

Final IF-003 recheck: full revision-page accounting now adds each complete serialized revision plus actual wrapper/comma/cursor overhead, stopping before constructing the full response. The permanent large-path/empty-file case refuses the full list and preserves `summary=1`. Independently ran permanent artifact+summary cases and both external original reproducers:12 tests/63 assertions passed (`.metaproject/data/gdctx/raw/2026-11-01T20-00-36-798Z-5af5ac_run.log`). Python semantic hydration/retention/archive/tamper preservation case passed independently (`.metaproject/data/gdctx/raw/2026-11-01T20-00-37-276Z-350170_run.log`).

Final scoped verdict: PASS. Exact snapshots and receipts (including noncanonical valid base64 aliases), format fencing/startup rollback, document archive retention, quota rollback, lazy hot metadata reads and response limits were rechecked. Carry-over F-002 remains explicitly partial for the bounded64MiB legacy metadata aggregate as described above; normal Work persistence is incremental. Deployment-profile argv fixture drift belongs to the root's separate in-flight integration and must pass its final full suite before publication.

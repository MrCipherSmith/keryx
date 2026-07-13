# Context — Flow 011 (W8 durable resume)

Collected by `keryx flow init` and enriched for W8. (T1 context.) Release 1.

## Baseline
- `bun test` = 797 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ d78faf9.

## Build on (reuse — do NOT rewrite)
- `src/harness/session/session.ts`: `AppendOnlySession` (append/manifest/entries/currentLeaf), `resumeSession`, `migrateSession`, `SessionDeps`, `AppendOptions` (attemptId), content-fingerprint dedup + entryId, `SessionManifest`/`SessionEntry` (causal {runId,sessionId,correlationId,parentEventId?}).
- `src/harness/run/run.ts`: `runOffline`, `RunResult`, `RunDeps`, `HarnessRunOutput` (+ `unresolvedRisks`), provider.stream with `attemptId: attempt-${runId}`.
- W5 ports, W6 fakes, `src/contracts` validator (`validateAgainstSchema`/`validateAgainstSchemaObject`).

## Scenarios (acceptance.feature)
- RS-01 (5): SC_R06_APPEND_ONLY_SESSION / RESUME_NO_DUPLICATE / SCHEMA_MIGRATION (@release-0 — already covered by W7 S2; reuse), **SC_R05_APPROVAL_RESUME** (@release-1, NEW), **SC_R11_EVIDENCE_SURVIVES_RESUME** (NEW/strengthen).
- RS-02 (3): **SC_R12_CRASH_CUT_PRE_EFFECT**, **SC_R12_CRASH_CUT_POST_EFFECT** (@release-1), **SC_R17_ISOLATED_REEXECUTE_DEFERRED**.
- Closes W7-deferred **SC_R12_TRANSIENT_RETRY** (retryable provider_error → new attempt within reservation).

## Schemas (validate durable payloads via src/contracts)
- `checkpoint`: checkpointId, sessionId, atEntryId, stateHash, createdAt, evidenceLedgerCursor.
- `execution-receipt`: receiptId, executionId, idempotencyKey, inputHash, observedAt, **outcome**, evidenceRefs.
- session-manifest/entry, replay-fixture/mismatch (effect-free recovery/reconcile).

## Fingerprint / attempt / failpoint map
- **Fingerprints** (injected, deterministic): `worktreeFingerprint` (worktree path + commit/dirty hash), `toolchainFingerprint` (pinned). Resume: match → continue attempt; mismatch (stale) → NEW attempt.
- **Immutable attempts**: leaf reconstructed from session+checkpoint; stale/crashed/failed → new attempt appended, prior immutable, evidence preserved, no dup (reuse W7 dedup). Transient-retry: retryable provider_error → new attempt within reservation, bounded.
- **Failpoint matrix (RS-02)**: crash-pre-effect → safe new attempt; crash-post-effect + outcome-KNOWN → reconcile from execution-receipt, no dup; crash-post-effect + outcome-UNKNOWN → BLOCK unsafe retry (require reconciliation); torn-write (truncated last entry) → recover to last intact; cancellation-cut → attempt cancelled, resumable. All injected — no real crash/fs.

## Target modules (src/harness/resume/)
- `store.ts` — `SessionStore` port (append/read serialized entries + checkpoint) + in-memory fake store. Real-fs adapter deferred/minimal.
- `fingerprint.ts` — worktree/toolchain fingerprints (injected).
- `resume.ts` (RS-01) — reconstruct leaf; immutable attempts; stale→new; approval-resume; evidence survives; transient-retry in run loop.
- `recovery.ts` (RS-02) — failpoint reconciliation; execution-receipt; outcome-unknown gating; torn-write/cancellation cut.

## Decisions (approved)
- SessionStore port + in-memory fake store (deterministic); real-fs adapter deferred. NO real crash/fs-write in tests.
- Reuse W7/W5/W6/src-contracts; NO new port/validator/dependency, NO network/SDK; deterministic (inject clock/id/fingerprint/failpoint — no Date.now/Math.random).

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. Verify after each. fetch-mocks `as unknown as typeof fetch`; guard array indexing.
- TDD order: RS-01 (T5→T6), RS-02 (T7→T8), review T9.

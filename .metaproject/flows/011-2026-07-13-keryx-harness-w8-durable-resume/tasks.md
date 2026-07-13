# Tasks — Flow 011 (W8 durable resume)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W8** (implementation-plan.md §W8). Resume/recovery over W7 — reuse,
do not rewrite. Deterministic/offline; no new dep/SDK/network; no real crash/fs in
tests. Worktree-guard in every worker.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Fingerprint/attempt/failpoint + module map (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T6+T8 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T5/T7 authored + impls green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T9 + completion done). |
| T5 | test (RS-01 RED) | Sonnet | `src/harness/resume/` tests: resume-by-fingerprint (worktree/toolchain), immutable attempts (stale→new, prior immutable), accepted evidence never duplicated, SC_R05_APPROVAL_RESUME (unchanged pending approval survives), SC_R11_EVIDENCE_SURVIVES_RESUME, transient-retry (retryable provider_error → new attempt within reservation). RED before T6. |
| T6 | impl (RS-01) | Opus | `src/harness/resume/{store,fingerprint,resume}.ts`: SessionStore port + in-memory fake; worktree/toolchain fingerprints; reconstruct leaf; immutable-attempt model (reuse W7 session dedup); run-loop transient-retry (wrapper over runOffline, minimal/additive). Make T5 green. |
| T7 | test (RS-02 RED) | Sonnet | `src/harness/resume/recovery.test.ts`: failpoint matrix — crash-pre-effect (safe new attempt), crash-post-effect + outcome-KNOWN (reconcile from execution-receipt, no dup), crash-post-effect + outcome-UNKNOWN (BLOCK unsafe retry), torn-write (recover to last intact), cancellation-cut (attempt cancelled, resumable), SC_R17 isolated re-exec deferred. Injected failpoints — no real crash/fs. RED before T8. |
| T8 | impl (RS-02) | Opus | `src/harness/resume/recovery.ts`: execution-receipt reconciliation + outcome-unknown gating + torn-write/cancellation recovery. Make T7 green. |
| T9 | review | Opus | code-verifier (`tsc` + full `bun test` ≥797 + new green); RS-01/RS-02 scenario coverage; `SC_R12_TRANSIENT_RETRY` closed; determinism/offline (no Date.now/Math.random/network/real-fs-write in resume code); `deps {}`; W7/W5/W6/src-contracts reused not rewritten; frozen requirements pkg + src/eval + src/contracts + ADRs untouched. |

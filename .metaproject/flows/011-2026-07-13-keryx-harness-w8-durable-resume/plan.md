# Implementation Plan — Flow 011 (W8 durable resume)

Status: frozen scope (W8 only) — Release 1

## Approach

Add a durable resume + recovery layer in `src/harness/resume/` over the W7
append-only session and run loop, test-first. Reconstruct the current leaf by
worktree/toolchain fingerprints; model immutable attempts (stale → new attempt,
no evidence duplication); reconcile crash/torn-write/cancellation cut points via
execution receipts with an outcome-unknown safety gate. Persistence is behind a
`SessionStore` port with an in-memory fake (deterministic; real-fs adapter
deferred). Reuse W7/W5/W6/src-contracts — no rewrites, no new dependency, offline.
Also close the W7-deferred `SC_R12_TRANSIENT_RETRY`.

## Worker routing & Model Policy

| Task | Kind | Worker | Model |
|---|---|---|---|
| T5 (RS-01 RED) | test | tests-creator | **Sonnet** |
| T6 (RS-01) | implement | task-implementer | **Opus 4.8** |
| T7 (RS-02 RED) | test | tests-creator | **Sonnet** |
| T8 (RS-02) | implement | task-implementer | **Opus 4.8** |
| T9 | review | review-orchestrator | **Opus 4.8** |
| T2/T3/T4 | umbrella | orchestrator | Opus |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each
with the worktree-guard (cd + pwd).

## Steps

1. T1: fingerprint/attempt/failpoint map + module map (context.md).
2. T5 (RS-01 RED): tests for resume-by-fingerprint, immutable attempts, stale→new,
   no-dup, SC_R05_APPROVAL_RESUME, SC_R11_EVIDENCE_SURVIVES_RESUME, transient-retry.
3. T6 (RS-01 GREEN): `resume/{store,fingerprint,resume}.ts` + run-loop transient-
   retry. Reuse W7 session dedup; SessionStore fake for tests.
4. T7 (RS-02 RED): failpoint matrix — crash-pre/post-effect, torn-write,
   cancellation, reconcile via execution-receipt, outcome-unknown blocks unsafe
   retry, SC_R17 isolated re-exec deferred.
5. T8 (RS-02 GREEN): `resume/recovery.ts` (execution-receipt reconciliation +
   outcome-unknown gating).
6. T9: `tsc` + full `bun test` (≥797 + new green); RS-01/RS-02 scenario coverage;
   `SC_R12_TRANSIENT_RETRY` closed; determinism/offline (no Date.now/random/network/
   real-fs); `deps {}`; reuse-only; frozen + src/eval + src/contracts untouched.
7. `keryx health run`; confirm ACs; completion choice (ask user A/B/C).

## Verification (TDD)

Each task RED before impl, GREEN after. Gate: `tsc` clean; full `bun test` ≥797 +
new green; failpoint matrix green; durable payloads schema-valid; no real crash/
fs-write in tests (injected failpoints); no new dependency.

## Risks

- **Non-determinism / real I/O** → inject clock/id/fingerprint/failpoint;
  SessionStore in-memory fake; AC forbids Date.now/random/network/real-fs in tests.
- **Duplicating evidence on resume/retry** → reuse W7 content-fingerprint dedup;
  immutable prior attempts; tests assert single evidence occurrence.
- **Unsafe retry after an ambiguous side effect** → outcome-unknown gate blocks
  retry until reconciliation (execution-receipt); RS-02 asserts this.
- **Rewriting W7/W5/W6** → additive `resume/` module; run-loop retry is a minimal
  additive change to run.ts (or a wrapper) — prefer a wrapper to avoid touching W7
  run.ts; if run.ts must change, keep it additive and note it.
- **Scope creep into W9+** → resume/recovery only; no branching/compaction/mutation.
- **Wrong-worktree / tsc-cast / index-guard** → guard directives in every dispatch.

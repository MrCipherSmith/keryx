# Flow 011 — W8 durable resume (RS-01, RS-02) — Release 1

Status: formalized
Source: user description (harness runbook, Phase 8 — Release 1)

## Problem

Release 0 (W1–W7) runs offline read-only but cannot resume a durable session or
recover from a crash: no leaf reconstruction by fingerprints, no immutable-attempt
model, no crash/torn-write/cancellation recovery. W8 adds the durable resume +
recovery layer over the W7 append-only session and run loop, and naturally closes
the W7-deferred `SC_R12_TRANSIENT_RETRY` (a retryable provider error records a new
attempt within the reservation).

## Expected Outcome

- **RS-01 (implement)** — reconstruct the current leaf using same-worktree/
  toolchain fingerprints and an immutable-attempt model: a stale result creates a
  NEW attempt, accepted evidence is never duplicated; an unchanged pending
  approval and prior evidence survive resume; a retryable provider error records a
  new attempt within the reservation.
- **RS-02 (test)** — exercise crash/torn-write/cancellation cut points and
  ambiguous side-effect reconciliation: crash-before-effect is safe, crash-after-
  effect with an unknown outcome BLOCKS an unsafe retry (reconcile via an
  execution receipt), torn-write/cancellation recover; isolated replay re-execution
  stays deferred. The failpoint matrix passes.

## Out of Scope (do NOT touch)

- Any wave other than W8. No branching/compaction (W9), mutation (W10), flow
  integration (W11), child (W12), parallel (W13), real provider (W14), hardening
  (W15).
- Rewriting W7 session/run, W5 ports, W6 fakes, or the src/contracts validator —
  REUSE them.
- The frozen requirements package + frozen ADR-0001…0004 — read/cite only.
- No new production dependency; no provider SDK; no network. Persistence is behind
  a `SessionStore` port with an in-memory fake for tests (real-fs adapter deferred)
  — NO real crash/fs-write in tests; determinism preserved.

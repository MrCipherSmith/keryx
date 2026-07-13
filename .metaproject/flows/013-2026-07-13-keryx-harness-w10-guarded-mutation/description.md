# Flow 013 — W10 guarded mutation + approval (M-01, M-02) — Release 1

Status: formalized
Source: user description (harness runbook, Phase 10 — Release 1) — SECURITY-CRITICAL

## Problem

Release 0/1 so far is read-only. W10 is the first controlled exit from read-only:
a mutation may only happen under a policy profile, a canonical action-fingerprint,
a single-use fingerprint-bound approval, path/argv/env rules, and a fail-closed
scan state; and it must be monitored with an execution receipt and reconciled for
unknown side effects. Unattended/untrusted mutation stays blocked without an
isolation boundary. Everything is fail-closed by default and uses a fake mutation
adapter (no real filesystem mutation).

## Expected Outcome

- **M-01 (implement)** — canonical action-fingerprints, single-use approvals
  (approval-request/result), path/argv/env rules, and fail-closed scan state:
  stale/denied/headless/expired approvals NEVER execute; path-traversal, symlink
  escape, shell injection, private-address redirect, and direct credential access
  are rejected. Composes the W3 policy engine.
- **M-02 (implement)** — monitored trusted-local mutation with an execution
  receipt and reconciliation (reusing W8 recovery): a guarded mutation after a
  valid approval is recorded with a receipt + evidence; unattended/untrusted
  mutation stays blocked without isolation; unknown side effects require
  reconciliation.

## Out of Scope (do NOT touch)

- Any wave other than W10. No flow integration (W11), child (W12), parallel (W13),
  real provider (W14), extension hardening (W15/H-02).
- Rewriting the W3 policy engine, W8 recovery/execution-receipt, W5/W6, or the
  src/contracts validator — REUSE/COMPOSE them.
- The frozen requirements package + frozen ADR-0001…0004 — read/cite only.
- No new production dependency; no provider SDK; no network. NO real filesystem
  mutation — a fake/injected mutation adapter only (real-fs adapter deferred).
  Determinism preserved; fail-closed by default.

# Flow 009 — W7 Release 0 read-only vertical slice (R0-01…R0-03)

Status: formalized
Source: user description (harness implementation runbook, Phase 7) — RELEASE BOUNDARY

## Problem

W4–W6 delivered the validator, ports, and offline fakes, but nothing assembles
them into a runnable harness. W7 builds the **Release 0 offline read-only
vertical slice**: an enabled run over the fake provider + fake tool with policy
allow/ask/deny, an append-only session, a bounded context manifest, evidence-
linked output, an evidence-gated completion, and effect-free offline replay —
across both CLI and JSONL/RPC with semantic parity. This is the Release 0
boundary; W16 (E-01…E-03) runs right after.

## Expected Outcome

An offline read-only run assembled from the W4/W5/W6 pieces that satisfies the
~29 Release 0 acceptance scenarios (`@task-R0-01/02/03` in acceptance.feature):
context-manifest → FakeProvider → FakeToolExecutor (policy allow/ask/deny) →
append-only session records → completion only on required evidence + gates →
resume/replay without duplicates or live side effects. Delivered as 5 sub-slices
(S1 startup, S2 session, S3 policy, S4 completion, S5 run+transport+replay), each
test-first.

## Out of Scope (do NOT touch)

- Any wave other than W7. No durable resume/branching/mutation/flow-integration/
  child/parallel (W8+); no real provider (W14).
- Rewriting W4 validator / W5 ports / W6 fakes — REUSE them.
- The frozen requirements package (schemas/protocols/acceptance) — read/cite only.
- `src/contracts`, `src/eval` — unchanged. No new production dependency; no
  network; no filesystem mutation; no provider SDK.
- Deferred OPEN values (real provider, per-role budget numbers, retention).

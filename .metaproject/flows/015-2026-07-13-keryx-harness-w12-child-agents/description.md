# Flow 015 — W12 Child agents (CA-01, CA-02) — Release 1

Status: formalized
Source: user description (harness runbook, Phase 12 — Release 1)

## Problem

The harness runs a single agent (W7) with resume (W8), branching (W9), guarded
mutation (W10), and a flow seam (W11), but it cannot yet **delegate** to a child
agent. The canonical gdskills `subagent-dispatch`/`subagent-result` contracts exist
(`.metaproject/core/gdskills/contracts/`) and a frozen `harness-child-contract-
extension.schema.json` defines the harness metadata that must ride on top of them,
but nothing adapts them into the harness: a parent cannot spawn an isolated,
budget-bounded, policy-inheriting child and receive its result as evidence. W12 adds
`src/harness/child/` so a parent adapts the canonical contracts (CA-01) and spawns a
child with isolated context/session, inherited (never-escalated) budget/policy, and
parent-owned completion (CA-02).

## Expected Outcome

- **CA-01 (implement)** — `src/harness/child/contract.ts` adapts the canonical
  `subagent-dispatch`/`subagent-result` with the frozen child-contract-extension
  metadata (parentRunId, sessionId, attempt, branchId, contextManifestHash,
  policyFingerprint, budgetReservation, durableResultArtifact). STATUS-first prose
  framing is converted to a canonical `subagent-result` BEFORE persistence.
  Round-trip identity + transport parity (CLI ⟺ JSONL-RPC) fixtures pass; the
  extension validates against the frozen schema via `src/contracts`.
- **CA-02 (implement)** — `src/harness/child/{isolation,spawn}.ts`: a child gets an
  isolated context/session (child events append-only into the parent session; the
  child cannot mutate parent state/evidence); budget inheritance is fail-closed
  (child budgetReservation ⊆ parent remaining — cannot exceed); policy inheritance is
  fail-closed (child cannot escalate trust/profile — never weaker than parent);
  provenance/parent-links recorded; NEEDS_CONTEXT / blocked / failed dispositions are
  returned to the parent AS EVIDENCE; the parent owns status/completion (the child
  never writes flow.json — completion flows through the W11 ManagedFlowPort); prior
  attempts are immutable (reuse W8). Deterministic (injected id/clock).

## Scope boundary (release tags)

The child-agent **acceptance scenarios** in `acceptance.feature` are frozen
`@release-2` (SC_R08_CHILD_DISPATCH_CANONICAL_RESULT, SC_R08_NEEDS_CONTEXT_ADAPTER;
SC_R08_BOUND_PARALLEL_WAVE belongs to W13). The **implementation tasks** CA-01/CA-02
are Release 1 (implementation-plan.md). W12 delivers the child-contract
implementation with its Release-1 evidence gates (round-trip + transport-parity
fixtures; child-negative tests); the `@release-2` acceptance scenarios are validated
later at the Release 2 boundary. W12 does NOT need to make the `@release-2`
scenarios pass.

## Out of Scope (do NOT touch)

- Any wave other than W12. No parallel scheduling (W13 / PA-01 / bounded waves), no
  real provider (W14), no hardening (W15). The `@release-2` child acceptance
  scenarios are validated later, not here.
- Rewriting W5/W6 ports+fakes, W7 completion/session/context/policy/evidence, W8
  resume, W9 branch, W10 mutation, W11 flow-port, or the src/contracts validator —
  REUSE them (composition only). If a prior module seems to need editing, STOP and
  report.
- The frozen requirements package + frozen ADR-0001…0004 — read/cite only.
- No new production dependency; no provider SDK; no network; no real fs mutation in
  tests (fake/injected adapters); the child NEVER writes flow.json (only via the
  ManagedFlowPort/API — parent owns completion).

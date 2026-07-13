# Implementation Plan — Flow 015 (W12 child agents)

Status: frozen scope (W12 only) — Release 1

## Approach

Add `src/harness/child/` so a parent can delegate to a child agent, test-first.
CA-01 adapts the canonical `subagent-dispatch`/`subagent-result` contracts with the
frozen `harness-child-contract-extension` metadata (STATUS-first prose converted to a
canonical result before persistence; round-trip + transport parity). CA-02 adds child
isolation + fail-closed budget/policy inheritance + provenance + NEEDS_CONTEXT/blocked/
failed dispositions returned to the parent as evidence, with the parent owning
completion (child NEVER writes flow.json — via W11 ManagedFlowPort). Reuse W7/W8/W9/W11
+ src/contracts; deterministic (injected id/clock).

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (CA-01 RED) | test | tests-creator | **Sonnet** | contract |
| T6 (CA-01) | implement | task-implementer | **Opus 4.8** | contract |
| T7 (CA-02 RED) | test | tests-creator | **Sonnet** | security/logic |
| T8 (CA-02) | implement | task-implementer | **Opus 4.8** | security/logic |
| T9 | review | review-orchestrator | **Opus 4.8** | contract + security/logic |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each with
the worktree-guard (cd + pwd).

## Steps

1. T1: integration map + frozen contract + D-02 + release-tag boundary (context.md).
2. T5 (CA-01 RED): `src/harness/child/` tests — adapter wraps canonical dispatch/result
   with the extension metadata; STATUS-first → canonical before persistence; round-trip
   identity; transport parity (CLI ⟺ RPC); extension validates against frozen schema.
3. T6 (CA-01 GREEN): `src/harness/child/contract.ts`. Make T5 green.
4. T7 (CA-02 RED): tests — isolation (child append-only into parent, no parent mutation);
   budget ⊆ parent fail-closed; policy not-weaker fail-closed; provenance; NEEDS_CONTEXT/
   blocked/failed → parent evidence; parent owns completion (no child flow.json write);
   prior attempts immutable; determinism.
5. T8 (CA-02 GREEN): `src/harness/child/{isolation,spawn}.ts`. Make T7 green.
6. T9: `tsc` + full `bun test` (≥924 + new green); child never writes flow.json (D-02);
   budget/policy inheritance fail-closed; parent owns completion; prior attempts
   immutable; determinism; reuse-only (W5–W11 + src/contracts unmodified); frozen pkg +
   src/eval + src/contracts + ADRs untouched; deps `{}`.
7. `keryx health run`; confirm ACs; completion choice (option B, verified handoff).

## Verification (TDD)

Each task RED before impl, GREEN after. Gate: `tsc` clean; full `bun test` ≥924 + new
green; child never writes flow.json; budget/policy inheritance fail-closed (child can't
exceed/weaken); parent owns completion; prior attempts immutable; extension validates
against the frozen schema; deterministic; no new dependency.

## Risks

- **Child writing flow.json (D-02 breach)** → the child returns evidence; completion
  flows only through the parent's ManagedFlowPort; T9 greps writeFlow/flow.json in
  src/harness/child = 0.
- **Budget/policy escalation** → inheritance is fail-closed: child budget ⊆ parent,
  child policy never weaker; T7 asserts DENIED on any exceed/weaken.
- **Mutating a canonical/replacement contract** → the extension is metadata over the
  canonical contracts, NOT a replacement; validate against the frozen schema; do not
  edit canonical schemas or src/contracts.
- **Rewriting W7/W8/W9/W11** → reuse-only; if a prior module seems to need editing,
  STOP and report.
- **Non-determinism** → injected id/clock only (NO Date.now/Math.random).
- **Wrong-worktree / tsc-cast / index-guard / frozen-array** → guard directives in
  every dispatch.

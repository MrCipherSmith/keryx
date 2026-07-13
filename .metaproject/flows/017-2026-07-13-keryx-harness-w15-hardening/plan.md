# Implementation Plan — Flow 017 (W15 security & recovery hardening)

Status: frozen scope (W15 only) — Release 1

## Approach

Run the cross-cutting hardening/red-team suites over the built Release-1 surface and
close the four deferred @release-0 concerns test-first: (1) broaden the mutation guard's
private-egress detection (SSRF encodings), (2) make approval expiry fail-closed on a
NaN/unparseable time, (3) add a fail-closed extension registry (SC_R18), (4) add a
budget-reservation reconciliation helper (SC_R16). Each guard is minimal and ADDITIVE
(denies more / new module; never changes an allow-path) and test-covered. Regression-
lock the existing fail-closed invariants (W10/W12/W13), recovery (W8), replay (W7), and
migration determinism, and measure deterministic performance/SLO bounds. H-02 documents
the deferred extension capability contract without enabling it. Provider/real-adapter
families (RP-01/W14) are deferred to a post-W14 H-01 re-run.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (H-01 security RED) | test | tests-creator | **Sonnet** | security |
| T6 (H-01 hardening) | implement | task-implementer | **Opus 4.8** | security |
| T7 (H-01 recovery/replay/migration/perf) | test | tests-creator | **Sonnet** | testing/perf |
| T8 (H-02 docs) | docs | docs writer | **Sonnet** | security |
| T9 | review | review-orchestrator | **Opus 4.8** | security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each with the
worktree-guard (cd + pwd).

## Steps

1. T1: hardening surface map + 4 deferred concerns + RP-01/W14 & release-tag deferrals
   (context.md).
2. T5 (H-01 security RED): red-team RED tests for SSRF encodings, NaN-date, unregistered-
   extension, budget-reconcile (missing/un-hardened → RED) + regression-lock of existing
   fail-closed invariants (already green).
3. T6 (H-01 GREEN): additive guard.ts (private-egress) + approval.ts (NaN fail-closed) +
   new extension/registry.ts + budget/reconcile.ts. Make T5 green.
4. T7 (H-01 recovery/replay/migration/perf): test-only suites over W7/W8 + migration
   determinism + deterministic SLO/perf bounds.
5. T8 (H-02 docs): deferred extension capability contract doc (later scope, not enabled).
6. T9: `tsc` + full `bun test` (≥1008 + new green); every new guard fail-closed
   (adversarial); no new high-severity; no regression (allow-paths preserved); deferred
   families explicitly marked; reuse-only; frozen + canonical schemas + src/eval +
   src/contracts + ADRs untouched; deps `{}`.
7. `keryx health run`; confirm ACs; completion (option B, verified handoff).

## Verification (TDD)

Each additive guard RED before impl, GREEN after. Gate: `tsc` clean; full `bun test`
≥1008 + new green; SSRF/NaN/extension/budget negatives fail-closed; existing fail-closed
invariants still hold (regression-lock); recovery/replay/migration/perf suites green; no
new dependency; deterministic.

## Risks

- **A hardening guard breaks an existing allow-path (regression)** → guards are ADDITIVE
  (only deny MORE); T5 keeps the existing allow-path assertions; T9 confirms the full
  suite stays green and no prior test flips.
- **SSRF broadening incomplete (still bypassable)** → T5 enumerates encoded/alt forms
  (IPv6/decimal/hex/octal/172.17-31/0.0.0.0/case); T9 adversarially probes for a
  remaining bypass.
- **NaN fail-open persists** → T5 asserts unparseable/NaN `expiresAt`/`now` → invalid;
  T9 checks the parse-failure branch denies.
- **Over-scoping into a real network/provider adapter** → NO network/SDK in W15; the
  extension registry + budget reconcile are PURE, offline, deterministic helpers.
- **Editing a frozen ADR for H-02** → H-02 is a NEW doc under docs/decisions/keryx-harness/;
  frozen ADR-0001..0004 stay untouched.
- **Wrong-worktree / tsc-cast / index-guard / frozen-array** → guard directives in every
  dispatch.

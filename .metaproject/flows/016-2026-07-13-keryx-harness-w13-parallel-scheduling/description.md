# Flow 016 — W13 Parallel scheduling (PA-01) — Release 1

Status: formalized
Source: user description (harness runbook, Phase 13 — Release 1)

## Problem

W12 gave the harness child agents (CA-01 canonical adapter, CA-02 isolated spawn +
fail-closed budget/policy inheritance), but a parent can only run ONE child at a
time — there is no scheduler that runs several ready children under a bounded
concurrency ceiling and an aggregate budget ceiling. The spec's "Parallel wave"
mode is "deferred until canonical child contracts, isolation, and aggregate budget
rules are implemented" — those are now in place (W12). W13 adds PA-01: a
deterministic bounded ready-set wave scheduler over the child-task graph.

## Expected Outcome

- **PA-01 (implement)** — `src/harness/parallel/` (`scheduler.ts` + optional
  `budget.ts`): a PURE, deterministic `planWaves(tasks, {maxConcurrency,
  parentRemaining}, deps)` that:
  1. **Bounded ready-set waves** — repeatedly takes the dependency-satisfied ready
     set, caps each wave at `maxConcurrency`, in a stable deterministic order.
  2. **Aggregate reservations** — folds the reused CA-02 `inheritBudget` across each
     wave against a decrementing `parentRemaining`, so the SUM of all child
     reservations never exceeds the parent's remaining budget (fail-closed deny on
     breach).
  3. **Cancellation** — a cancelled task and its transitive dependents are excluded
     from every wave, deterministically.
  4. **Loop detection** — if tasks remain but none are ready (no progress), the
     dependency graph has a cycle → `{ok:false}` (fail-closed, no partial wave).
  Deterministic: injected id/clock, no `Date.now`/`Math.random`, stable ordering.
  Evidence gate: concurrency and budget ceilings are enforced; budget/loop negatives
  hold.

## Scope boundary (release tags)

`SC_R08_BOUND_PARALLEL_WAVE` (@R8 @R12 @release-2) — "a FUTURE coordinator has
reserved an aggregate budget and concurrency of two … three ready … no more than two
run concurrently" — is frozen `@release-2`. W13 delivers the Release-1 PA-01
implementation with its Release-1 evidence gates (concurrency + budget ceilings; the
budget/loop negative families); the full `@release-2` wave scenario (and the live
concurrent coordinator) is validated at the Release 2 boundary, NOT here.

## Out of Scope (do NOT touch)

- Any wave other than W13. No real provider (W14), no hardening (W15). The
  `@release-2` parallel scenario is validated later.
- Rewriting W5/W6 ports+fakes, W7 completion/session/context/policy/evidence, W8
  resume, W9 branch, W10 mutation, W11 flow-port, or W12 child (CA-01/CA-02) — REUSE
  them (composition only; especially `inheritBudget`). If a prior module seems to
  need editing, STOP and report.
- The frozen requirements package + frozen ADR-0001…0004 + canonical contract
  schemas + `src/contracts` validator — read/cite only.
- No new production dependency; no provider SDK; no network; no real fs mutation in
  tests; the scheduler/child NEVER writes flow.json (the parent owns completion via
  the W11 ManagedFlowPort — D-02). No real async concurrency: the scheduler is a
  deterministic pure function over the task graph.

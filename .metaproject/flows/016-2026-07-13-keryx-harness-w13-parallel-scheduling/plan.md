# Implementation Plan — Flow 016 (W13 parallel scheduling)

Status: frozen scope (W13 only) — Release 1

## Approach

Add `src/harness/parallel/` with a PURE, deterministic bounded ready-set wave
scheduler, test-first. `planWaves` takes a child-task graph + `{maxConcurrency,
parentRemaining}` and produces waves that (1) respect the concurrency ceiling, (2)
reserve aggregate budget by folding the reused CA-02 `inheritBudget` so the sum never
exceeds the parent's remaining (fail-closed), (3) exclude cancelled tasks and their
transitive dependents, and (4) fail closed on a dependency cycle. No real async — the
scheduler is a pure function over the graph. Reuse W12; deterministic (injected
id/clock).

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (PA-01 RED) | test | tests-creator | **Sonnet** | highload |
| T6 (PA-01) | implement | task-implementer | **Opus 4.8** | highload |
| T7 | review | review-orchestrator | **Opus 4.8** | highload/security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each with
the worktree-guard (cd + pwd).

## Steps

1. T1: integration map + reuse surface (inheritBudget) + D-02 + release-tag boundary
   (context.md).
2. T5 (PA-01 RED): `src/harness/parallel/` tests — bounded waves (3 ready, cap 2 →
   [2,1]); dependency ordering; aggregate budget (Σ ≤ parent remaining, fail-closed on
   breach); cancellation (cancelled + transitive dependents excluded); loop detection
   (cycle → deny); determinism.
3. T6 (PA-01 GREEN): `src/harness/parallel/scheduler.ts` (+optional `budget.ts`)
   composing `inheritBudget`. Make T5 green.
4. T7: `tsc` + full `bun test` (≥991 + new green); concurrency ceiling enforced; budget
   ceiling enforced (aggregate ≤ parent, fail-closed); loop + cancellation negatives
   real; D-02 (no flow.json write in src/harness/parallel); reuse-only (W5–W12 +
   inheritBudget unmodified); determinism; frozen + src/eval + src/contracts + canonical
   schemas untouched.
5. `keryx health run`; confirm ACs; completion choice (option B, verified handoff).

## Verification (TDD)

Each task RED before impl, GREEN after. Gate: `tsc` clean; full `bun test` ≥991 + new
green; concurrency + budget ceilings enforced; budget/loop negatives asserted (non-
vacuous); scheduler writes no flow.json; deterministic; no new dependency.

## Risks

- **Budget ceiling not enforced in aggregate (fail-open)** → the aggregate reservation
  folds `inheritBudget` against a decrementing remaining; T7 asserts a wave whose sum
  would exceed the parent is DENIED; a child can never end with more budget than the
  parent had.
- **Cycle not detected (infinite/partial schedule)** → loop detection: tasks remain
  AND ready-set empty → deny; T5/T7 assert a real cycle fixture denies.
- **Non-determinism** → pure scheduler, stable order, injected id/clock; no
  Date.now/Math.random.
- **Rewriting W12 inheritBudget / child** → reuse-only; compose, do not edit; if a
  change seems needed, STOP and report.
- **Scheduler writing flow.json (D-02 breach)** → the scheduler is pure and returns a
  plan; the parent owns completion via ManagedFlowPort; T7 greps writeFlow/flow.json in
  src/harness/parallel = 0.
- **Wrong-worktree / tsc-cast / index-guard / frozen-array** → guard directives in
  every dispatch.

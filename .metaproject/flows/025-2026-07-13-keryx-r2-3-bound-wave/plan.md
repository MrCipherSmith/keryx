# Implementation Plan — Flow 025 (Release 2 · R2-3 bound-parallel-wave over registered extensions)

Status: frozen scope (R2-3 only) — Release 2

## Approach

Add `src/harness/extension/bound-wave.ts` — `planExtensionWave` — composing the W13
`planWaves` scheduler, R2-1 `dispatchExtension`, W12 budget, W7 evidence, and W8 immutable
attempts, test-first: bind a bounded parallel wave to REGISTERED extensions with an
aggregate budget + concurrency ceiling and per-attempt evidence isolation. Reuse-only;
deterministic/offline; deps `{}`.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | highload/security |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | highload/security |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | highload/security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd /Users/Goodea/goodea/keryx`).

## Steps

1. T1: R2-3 scope + SC_R08_BOUND_PARALLEL_WAVE + reuse surface + integration map (context.md).
2. T5 (RED): `bound-wave.ts` tests — 3 registered-extension tasks + config {maxConcurrency:2,
   parentRemaining} → a bounded plan where no wave has >2 tasks (concurrency); aggregate budget
   Σ ≤ parent (fail-closed on breach, reuse planWaves); every task dispatched via R2-1
   dispatchExtension (bounded to grant); an UNREGISTERED task → deny (fail-closed); each attempt
   has its OWN EvidenceRecord (per-attempt isolation; attempts immutable — `.toThrow()`/deep-equal);
   a cycle / degenerate concurrency → deny (propagated from planWaves); determinism.
3. T6 (GREEN): `src/harness/extension/bound-wave.ts` composing W13/R2-1/W12/W7/W8. Additive helper
   only if needed. Make T5 green.
4. T7 (review): concurrency ceiling enforced (no wave >maxConcurrency); aggregate budget fail-closed
   (Σ ≤ parent — adversarial); unregistered-extension → deny (no wave binds); per-attempt evidence
   isolation (one attempt's evidence never mutates another's); D-02 (no flow.json write); reuse-only
   (W13/R2-1/W12/W7/W8 unmodified or additive); determinism (no Date.now/Math.random, no real async);
   deps `{}`; frozen pkg + canonical schemas + src/eval + src/contracts + ADRs untouched.
5. `keryx health run`; confirm ACs; completion (option B) + PR (no co-authorship). NOTE: resolve the
   runbook Release 2 Стейт conflict with R2-2 (#27) at merge (keep both ✅).

## Verification

Gate: `tsc` clean; full `bun test` ≥1254 + new green; a bound wave respects the concurrency ceiling
(≤ maxConcurrency per wave) and the aggregate budget (Σ ≤ parent, fail-closed); only registered
extensions bind; each attempt has its own evidence history (isolated + immutable); the scheduler/
extension write no flow.json; deterministic; no new dependency / no real async.

## Risks

- **Concurrency ceiling breached** → REUSE `planWaves` (already caps each wave at maxConcurrency);
  T5/T7 assert 3 ready + maxConcurrency 2 → no wave >2.
- **Aggregate budget over-grant** → REUSE `planWaves` folded `inheritBudget` (Σ ≤ parent, fail-closed);
  T7 adversarial (can Σ exceed parent?).
- **A wave binds to an unregistered extension** → every task's `registration.ok` checked; unregistered
  → deny; T5/T7 assert.
- **Attempt evidence cross-contamination** → per-attempt EvidenceRecord; attempts immutable (W8); T7
  asserts one attempt's evidence never mutates another's.
- **Rewriting W13/R2-1/W12/W7/W8** → reuse-only/additive; if a real refactor seems needed, STOP.
- **Non-determinism / new dep / real async** → injected id/clock; pure sync; no SDK/network; deps `{}`.
- **flow.json write / fs mutation** → the plan is returned (no fs); T7 greps writeFlow/flow.json = 0.
- **Wrong-worktree / index-guard / frozen-array** → guard directives in every dispatch.

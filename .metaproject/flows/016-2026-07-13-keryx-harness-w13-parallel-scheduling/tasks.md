# Tasks — Flow 016 (W13 parallel scheduling)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W13** (implementation-plan.md PA-01). New code under
`src/harness/parallel/`. Reuse W12 `inheritBudget` + child/budget types — composition
only, NO rewrite. Scheduler/child NEVER write flow.json (parent owns completion via the
W11 ManagedFlowPort — D-02). Deterministic pure scheduler (no real async, no
Date.now/Math.random). No new dep/SDK/network. Worktree-guard. Release-tag boundary: the
@release-2 SC_R08_BOUND_PARALLEL_WAVE scenario is NOT gated here.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Integration map + PA-01 spec + reuse (inheritBudget) + D-02 + release-tag boundary (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T6 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T5 authored + impl green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T7 + completion done). |
| T5 | test (PA-01 RED) | Sonnet | `src/harness/parallel/scheduler.test.ts`: `planWaves(tasks, {maxConcurrency, parentRemaining}, deps)` over a `ChildTask[]` graph (`{taskId, dependsOn, budgetRequest: BudgetReservation, cancelled?}`). Cases: **bounded waves** (3 independent ready + maxConcurrency 2 → wave1 has 2, wave2 has 1, in stable order); **dependency ordering** (a task with `dependsOn:[X]` never appears before the wave after X); **aggregate budget** (Σ of a wave's reservations ≤ parentRemaining, decrementing across waves, via reused `inheritBudget`; a task whose reservation would breach the running remaining → `{ok:false}` fail-closed); **cancellation** (a cancelled task AND its transitive dependents are excluded from all waves); **loop detection** (a dependency cycle → `{ok:false; reason:"cycle…"}`, no partial waves); **determinism** (identical inputs twice → deep-equal plan; no Date.now/Math.random). Negatives: budget-breach, cycle. RED before T6. |
| T6 | impl (PA-01) | Opus (highload) | `src/harness/parallel/scheduler.ts` (+optional `src/harness/parallel/budget.ts`): `planWaves` — ready-set computation, maxConcurrency cap (stable order), aggregate reservation folding `inheritBudget` (fail-closed), cancellation (transitive dependent exclusion), loop detection. Pure/deterministic. Make T5 green. |
| T7 | review | Opus (highload) | code-verifier (`tsc` + full `bun test` ≥991 + new green); **concurrency ceiling enforced** (no wave exceeds maxConcurrency); **budget ceiling enforced** (aggregate Σ ≤ parent remaining, fail-closed — adversarial: can any child end with more budget than the parent had? must be impossible); **loop + cancellation negatives real** (non-vacuous — a genuine cycle/cancel fixture denies/excludes); D-02 (`ctx rg` writeFlow/flow.json in src/harness/parallel = 0; scheduler is pure, writes nothing); reuse-only (W5–W12 + `inheritBudget` unmodified — composed not rewritten); determinism (no Date.now/Math.random); frozen requirements pkg + src/eval + src/contracts + canonical schemas + ADRs untouched; deps `{}`. Lens: highload + security. |

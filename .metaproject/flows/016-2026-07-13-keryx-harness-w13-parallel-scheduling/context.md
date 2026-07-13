# Context — Flow 016 (W13 parallel scheduling)

Collected by `keryx flow init` and enriched for W13. (T1 context.) Release 1.

## Baseline
- `bun test` = 991 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ df274ac.

## Frozen spec (implementation-plan.md — execute verbatim)
- **PA-01** (implement, reviewer=highload): "Add bounded ready-set waves, aggregate
  reservations, cancellation, and loop detection." Depends CA-02. Negatives:
  "budget/loop negatives." Evidence: "concurrency and budget ceilings are enforced."

## No frozen wave schema
There is NO frozen parallel/wave/schedule schema — PA-01 is internal scheduling logic.
Nothing new to validate against a frozen schema; reuse the W12 child budget types.
Config knob from the spec example: `maxConcurrentChildren: 2` (specification.md §
Orchestration config). Spec §Orchestration Model item 4: "Parallel wave — deferred
until canonical child contracts, isolation, and aggregate budget rules are implemented"
(now satisfied by W12).

## Scope boundary (release tags)
`SC_R08_BOUND_PARALLEL_WAVE` (@R8 @R12 @release-2, acceptance.feature): "Given a FUTURE
coordinator has reserved an aggregate budget and concurrency of two / When three
independent child tasks are ready / Then no more than two run concurrently / And each
attempt has its own evidence history." Frozen @release-2 → NOT gated in W13. W13 = the
Release-1 PA-01 implementation with concurrency + budget-ceiling evidence + budget/loop
negatives.

## Build on (reuse — do NOT rewrite; new code under src/harness/parallel/)
- W12 CA-02 `src/harness/child/isolation.ts`: `inheritBudget(parentRemaining:
  ParentRemainingBudget, childRequest: BudgetReservation): InheritBudgetResult`
  (fail-closed; `{ok:true;reservation}|{ok:false;reason}`), `BudgetReservation`
  (`reservationId, maxRuntimeMs, maxToolCalls?`), `ParentRemainingBudget`
  (`maxRuntimeMs, maxToolCalls?`). Aggregate reservation = fold `inheritBudget` across
  a wave against a DECREMENTING parentRemaining (the caller-driven aggregate pattern
  CA-02 already documents). NEVER exceed the parent's remaining in aggregate.
- W12 CA-01/CA-02 `src/harness/child/{contract,spawn}.ts`: `ChildContractExtension`,
  `spawnChild`, `ChildSpawnResult` (compose if the scheduler emits per-task spawn
  inputs; the scheduler itself stays pure).
- W11 `src/harness/flow/managed-flow-port.ts`: the parent owns completion; the
  scheduler writes no flow.json.
- W7 evidence/session types if a wave plan needs to reference evidence/attempt ids.

## D-02 invariant (ADR-0002)
The scheduler and children NEVER write flow.json. Only the Task Manager (`src/flow`)
writes flow.json; the parent advances the flow via `ManagedFlowPort`. One loop
authority = Task Manager / the parent coordinator.

## Invariant / integration map
- **planWaves (PA-01):** `planWaves(tasks: ChildTask[], config: {maxConcurrency:
  number; parentRemaining: ParentRemainingBudget}, deps): PlanResult`.
  - `ChildTask = { taskId: string; dependsOn: string[]; budgetRequest:
    BudgetReservation; cancelled?: boolean }` (dependsOn refers to other taskIds).
  - Ready-set = tasks whose `dependsOn` are all scheduled in a PRIOR wave, not
    cancelled, not transitively-dependent on a cancelled task.
  - Each wave capped at `maxConcurrency`; deterministic stable order (by taskId).
  - Aggregate reservation folds `inheritBudget`; Σ across all waves ≤ parentRemaining
    (fail-closed: a task whose reservation would breach the running remaining → deny
    the plan with a typed reason).
  - Loop detection: tasks remain AND ready-set empty (no progress) → `{ok:false;
    reason:"cycle …"}`.
  - Result: `{ok:true; waves: Wave[]} | {ok:false; reason: string}` where `Wave =
    { taskIds: string[]; reservations: BudgetReservation[] }` (or similar; the RED
    test pins the exact shape).
  - Pure/deterministic: no Date.now/Math.random; injected id/clock only.

## Target modules
- `src/harness/parallel/scheduler.ts` (PA-01) — `planWaves` + ready-set/concurrency/
  cancellation/loop-detection.
- `src/harness/parallel/budget.ts` (PA-01, optional) — aggregate-reservation fold over
  a wave composing `inheritBudget` (fail-closed). May be inlined into scheduler.ts.

## Decisions (approved)
- New code under `src/harness/parallel/` only. Reuse W12 `inheritBudget` +
  child/budget types (composition; NO rewrite). Deterministic pure scheduler (NO real
  async, NO Date.now/Math.random). Scheduler/child NEVER write flow.json (parent owns
  completion via ManagedFlowPort). No new port/validator/dependency, no network/SDK.
  PA-01 is one implement task; run TDD (RED test Sonnet → GREEN impl Opus/highload →
  review Opus/highload).

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. fetch-mocks `as unknown as typeof fetch`; guard array indexing; immutability via `.toThrow()`.
- TDD order: PA-01 (T5→T6), review T7.

# Context — Flow 025 (Release 2 · R2-3 bound-parallel-wave over registered extensions)

Collected by `keryx flow init` and enriched. (T1 context.) Release 2, Wave R2-3.

## Baseline
- Branch `feature/keryx-release2-bound-wave` from `main` (R0+R1+R2-1+R2-4; R2-2 in-flight PR #27,
  NOT needed — R2-3 depends on R2-1 only). `bun test` = 1254 pass / 0 fail; `tsc` clean; deps `{}`.
- Flow renumbered 024→025 (024 collides with R2-2's unmerged flow).

## Frozen scope (E-03 §4 AC-R2-3) — SC_R08_BOUND_PARALLEL_WAVE (acceptance.feature:467)
"coordinator reserved AGGREGATE budget + CONCURRENCY of two / three independent child tasks
ready / no more than two run concurrently / each attempt has its own evidence history." Extends
PA-01's `planWaves` to a registered-extension-bound wave. Depends on R2-1.

## Reuse surface (compose/additive; do NOT rewrite)
- **W13 scheduler** `src/harness/parallel/scheduler.ts`: `planWaves(tasks: ChildTask[], config:
  PlanWavesConfig, deps?: PlanWavesDeps): PlanWavesResult`. `ChildTask {taskId; dependsOn: string[];
  budgetRequest: BudgetReservation; cancelled?}`. `PlanWavesConfig {maxConcurrency; parentRemaining:
  ParentRemainingBudget}`. `Wave {taskIds: string[]; reservations: BudgetReservation[]}`.
  `PlanWavesResult {ok:true; waves}|{ok:false; reason}`. Already fail-closed: aggregate budget
  (Σ ≤ parent remaining), concurrency cap (≤ maxConcurrency per wave), cycle → deny, degenerate
  maxConcurrency (<1) → deny.
- **R2-1 execute.ts** `src/harness/extension/execute.ts`: `dispatchExtension(input:
  DispatchExtensionInput, deps: {idSeq; clock}): {ok:true; dispatch; extension; parseResult}|
  {ok:false; reason}` — fail-closed on an unregistered extension (`input.registration.ok===false`);
  `allowed_actions` bounded to the grant. `evaluateExtensionGrant` available.
- **W15 registry** `src/harness/extension/registry.ts`: `registerExtension → {ok:true;extensionId}|
  {ok:false;reason}`, `CapabilityGrant`, `ExtensionManifest`, `RegisterExtensionResult`.
- **W12 isolation** `src/harness/child/isolation.ts`: `inheritBudget` (already folded in planWaves),
  `BudgetReservation {reservationId; maxRuntimeMs; maxToolCalls?}`, `ParentRemainingBudget`.
- **W7 evidence** `src/harness/evidence/types.ts`: `EvidenceRecord`, `EvidenceKind`,
  `EvidenceProvenance`, `EvidenceCausalIds`, `EvidenceArtifactRef`. **W12 spawn**
  `src/harness/child/spawn.ts`: `childResultToEvidence(input, deps): EvidenceRecord` (disposition →
  EvidenceRecord). **W8 resume**: immutable attempts (a new attempt never mutates a prior).
- **W11 flow-port** `src/harness/flow/managed-flow-port.ts`: parent owns completion; the
  scheduler/extension never write flow.json.

## Invariant / integration map
- **planExtensionWave(input, deps):** input = `{ tasks: ExtensionWaveTask[]; config: PlanWavesConfig;
  parent context (parentRunId/sessionId/attempt/branch/context/policy fingerprints,
  canonicalContractVersion, reservedBudget) }`, where each `ExtensionWaveTask = { taskId; dependsOn;
  registration: RegisterExtensionResult; capabilityGrant; budgetRequest: BudgetReservation; + per-task
  dispatch fields }`.
  1. **Registered-only:** every task's `registration.ok` must be true; an unregistered task → deny the
     wave (or that task) fail-closed (no wave binds to an unregistered extension).
  2. **Bounded schedule:** map to `ChildTask[]` (taskId/dependsOn/budgetRequest) → REUSE `planWaves` →
     bounded waves (concurrency ceiling: 3 ready + maxConcurrency 2 → no wave >2; aggregate budget:
     Σ ≤ parent remaining, fail-closed). Propagate a `planWaves` deny (budget/cycle/degenerate).
  3. **Extension dispatch per task:** for each scheduled task, REUSE R2-1 `dispatchExtension` → a
     canonical dispatch bounded to its grant.
  4. **Per-attempt evidence history:** each task/attempt gets its OWN `EvidenceRecord` (reuse
     `childResultToEvidence` / W7 evidence); attempts are isolated + immutable (reuse W8) — one
     attempt's evidence never mutates another's (assert deep-equality / `.toThrow()`).
  Result: `{ok:true; waves: BoundWave[]}|{ok:false; reason}`; `BoundWave {taskIds; dispatches;
  attemptEvidence}`. Deterministic (injected id/clock; stable order from planWaves).

## D-02 / security
- The scheduler/extension NEVER write flow.json; the parent owns completion via ManagedFlowPort. An
  unregistered extension can't bind to a wave; budget breach / cycle / degenerate concurrency → deny.

## Target modules
- `src/harness/extension/bound-wave.ts` (NEW) — `planExtensionWave` + `ExtensionWaveTask`/`BoundWave`.
- `src/harness/parallel/scheduler.ts` / `execute.ts` — additive helper ONLY if strictly needed.

## Decisions (approved)
- New `src/harness/extension/bound-wave.ts`; additive-only. Reuse W13 planWaves + R2-1 dispatchExtension
  + W12 inheritBudget/BudgetReservation + W15 registry + W7 evidence + W8 immutable. NO new dep/SDK/
  network/real-async (deps `{}`). Deterministic (injected id/clock). Fail-closed. D-02. No co-authorship.
- TDD: RED (Sonnet) → impl (Opus highload) → review (Opus highload/security). Pure deterministic
  scheduler logic → no live smoke; offline throughout.

## Operational
- keryx = `bun ./src/cli.ts`. Root = `/Users/Goodea/goodea/keryx` (branch feature/keryx-release2-bound-wave).
  Never commit to main; PR at the end (no co-authorship). NOTE: R2-3 edits the runbook Release 2 Стейт →
  will conflict with R2-2 (#27) at merge; resolve then (keep both ✅).
- State only via `keryx flow` (flow 025); workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx && pwd` first, write ONLY under it.
  Guard array indexing; injected id/clock; no real fs/network/async; `.toThrow()` for immutability.
- Order: T5 (RED) → T6 (impl) → T7 (review).

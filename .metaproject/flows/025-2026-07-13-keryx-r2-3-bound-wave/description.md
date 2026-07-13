# Flow 025 — Release 2 · Wave R2-3: bound-parallel-wave over registered extensions

Status: formalized
Source: user runbook prompt (Release 2, Wave R2-3). Frozen scope from
`docs/decisions/keryx-harness/E-03-release1-handoff.md` §4 AC-R2-3.

## Problem

W13 (`planWaves`) schedules bounded ready-set waves of generic child tasks; R2-1
(`dispatchExtension`) dispatches a single registered extension with bounded authority.
Nothing binds a parallel wave TO registered extensions: a coordinator can't run several
registered-extension dispatches under one aggregate budget + concurrency ceiling with
per-attempt evidence isolation. R2-3 extends the W13 scheduler to accept a
registered-extension-bound wave. Depends on R2-1 (`src/harness/extension/execute.ts`,
already on main).

## Scope (frozen: E-03 §4 AC-R2-3) — 1 scenario

**SC_R08_BOUND_PARALLEL_WAVE** (acceptance.feature:467, @R8 @R12 @release-2 @positive):
"Given a coordinator has reserved an AGGREGATE budget and a CONCURRENCY of two / When
three independent child tasks are ready / Then no more than two run concurrently / And
each attempt has its own evidence history."

NOT in scope: R2-1/R2-2/R2-4 (done/other), R2-5 (real-subprocess).

## Expected Outcome

- New `src/harness/extension/bound-wave.ts`:
  - **planExtensionWave(input, deps)** — takes a set of REGISTERED-extension wave tasks
    (each `{ taskId; dependsOn; registration; capabilityGrant; budgetRequest; + the
    dispatch context }`) + a `PlanWavesConfig` `{ maxConcurrency; parentRemaining }`:
    1. Every task's extension MUST be registered (registry `ok`); an unregistered/ungranted
       task fails closed (deny — no wave binds to an unregistered extension).
    2. Map the tasks to W13 `ChildTask[]` (taskId/dependsOn/budgetRequest) and call the
       REUSED `planWaves` → bounded waves respecting the concurrency ceiling (3 ready +
       maxConcurrency 2 → no wave has >2 tasks) and the AGGREGATE budget (Σ reservations ≤
       parent remaining, fail-closed on breach — W13's folded `inheritBudget`).
    3. For each scheduled task, build a canonical registered-extension dispatch via the
       REUSED R2-1 `dispatchExtension` (bounded to its grant).
    4. **Each attempt has its OWN evidence history** — a per-task/attempt `EvidenceRecord`
       (reuse W7 evidence / W12 `childResultToEvidence`); attempts are isolated + immutable
       (reuse W8 immutable-attempts) — one attempt's evidence never mutates another's.
  - Result: `{ ok: true; waves: BoundWave[] } | { ok: false; reason }` where each
    `BoundWave` carries its `taskIds`, the per-task extension `dispatch`, and the per-attempt
    evidence. Deterministic (injected id/clock; stable order via `planWaves`).
- Additive edits to `scheduler.ts` / `execute.ts` only if strictly needed — prefer none.

## Out of Scope (do NOT touch)

- R2-1 (reuse `execute.ts` unchanged) / R2-2 / R2-4 / R2-5. No new dependency (`dependencies`
  stays `{}`), no SDK, no network, no REAL async concurrency (the scheduler is a pure
  deterministic function over the task graph — "concurrency" is modeled, not real threads).
  No real fs mutation in tests. The scheduler/extension NEVER write flow.json — the parent
  owns completion via the W11 ManagedFlowPort (D-02). Deterministic (injected id/clock; no
  `Date.now`/`Math.random`).
- Rewriting W13 `planWaves`, R2-1 `dispatchExtension`, W12 `inheritBudget`, W15 registry, W7
  evidence, or W8 immutable-attempts — REUSE them (composition/additive only). If a prior
  module seems to need a real refactor, STOP and report.
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/` +
  `src/contracts/` — read/cite only. Commits/PR carry NO co-authorship trailer.
- Fail-closed: an unregistered extension can't bind to a wave; a budget breach / cycle /
  degenerate concurrency denies (reuse W13 fail-closed).

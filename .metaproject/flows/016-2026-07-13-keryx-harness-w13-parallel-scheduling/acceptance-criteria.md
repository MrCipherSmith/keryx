# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: PA-01 bounded ready-set waves — `src/harness/parallel/scheduler.ts` defines a PURE, deterministic `planWaves(tasks, {maxConcurrency, parentRemaining}, deps)` over a child-task graph (`{taskId, dependsOn, budgetRequest, cancelled?}`) that emits ordered waves in which (a) every task's `dependsOn` are all scheduled in a strictly earlier wave, and (b) NO wave contains more than `maxConcurrency` tasks; wave membership and ordering are deterministic (stable by taskId; identical inputs yield a deep-equal plan; no `Date.now`/`Math.random`).
- AC2: Aggregate budget ceiling (fail-closed) — the scheduler reserves aggregate budget by folding the reused W12 `inheritBudget` across the tasks against a decrementing `parentRemaining`, so the SUM of all granted child reservations never exceeds the parent's remaining budget; a task whose reservation would breach the running remaining causes a fail-closed denial (`{ok:false}` with a typed reason), never a silent over-grant. A child can never end up with more budget than the parent had (concurrency and budget ceilings are enforced).
- AC3: Cancellation + loop detection (budget/loop negatives) — a cancelled task AND its transitive dependents are excluded from every wave, deterministically; a dependency cycle (tasks remain but the ready-set is empty — no progress) is detected and returns `{ok:false; reason}` with no partial/ambiguous wave emitted (fail-closed). Both negative families are asserted by non-vacuous fixtures.
- AC4: D-02 + reuse — the scheduler and children NEVER write flow.json (no `writeFlow`/flow.json write is reachable from `src/harness/parallel/**`; the scheduler is a pure function returning a plan; the parent owns completion via the W11 ManagedFlowPort); the W12 `inheritBudget` and child types are REUSED (composed, not rewritten) and W5/W6/W7/W8/W9/W10/W11/W12 source is unmodified.
- AC5: No regression / scope / determinism — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 991 pass with the new tests green and 0 fail; new code lives under `src/harness/parallel/` only; behavior is deterministic (injected id/clock, no `Date.now`/`Math.random`); no new production dependency (`dependencies` `{}`), no provider SDK, no network, no real fs mutation in tests, no real async concurrency; the frozen requirements package, canonical contract schemas, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified. The `@release-2` SC_R08_BOUND_PARALLEL_WAVE scenario is out of scope for W13.

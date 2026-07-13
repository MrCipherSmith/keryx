# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Bound wave over registered extensions + concurrency ceiling (SC_R08_BOUND_PARALLEL_WAVE) — `src/harness/extension/bound-wave.ts` `planExtensionWave` takes a set of REGISTERED-extension wave tasks + a `PlanWavesConfig` `{maxConcurrency, parentRemaining}` and, by reusing the W13 `planWaves` scheduler, produces bounded waves in which NO wave contains more than `maxConcurrency` tasks (three independent ready tasks with `maxConcurrency:2` → no more than two per wave); every scheduled task carries a canonical registered-extension dispatch (via the reused R2-1 `dispatchExtension`) bounded to its capability grant.
- AC2: Aggregate budget fail-closed — the wave reserves aggregate budget via the reused `planWaves` fold of `inheritBudget`, so the sum of the granted reservations never exceeds the parent's remaining budget; a task set whose aggregate would breach the parent remaining is denied fail-closed (`{ok:false}` with a budget reason); a cycle / degenerate `maxConcurrency` (<1) is likewise denied (propagated from `planWaves`).
- AC3: Registered-only (fail-closed) — a wave task whose extension is NOT registered (`registration.ok === false`) causes `planExtensionWave` to deny fail-closed (a wave never binds to an unregistered/ungranted extension); no silent authority.
- AC4: Per-attempt evidence history + D-02 — each wave task/attempt carries its OWN `EvidenceRecord` (per-attempt evidence isolation, reusing W7 evidence / W12 `childResultToEvidence`); one attempt's evidence never mutates another's and prior attempts are immutable (reuse W8); the scheduler/extension NEVER write flow.json (no `writeFlow`/flow.json write is reachable from `src/harness/extension/bound-wave.ts`; the parent owns completion via the W11 ManagedFlowPort); the W13 `planWaves`, R2-1 `execute.ts` (`dispatchExtension`), W12 `inheritBudget`, W15 registry, W7 evidence, and W8 immutable-attempts are REUSED (composition / additive-only — no rewrite).
- AC5: No regression / determinism / scope / deps — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 1254 pass with the new tests green and 0 fail; behavior is deterministic (injected id/clock, no `Date.now`/`Math.random`, no REAL async concurrency — the scheduler is a pure function over the task graph); no new production dependency (`dependencies` `{}`), no provider SDK, no network, no real fs mutation in tests; new runtime code lives under `src/harness/extension/` (with additive-only edits to prior modules if strictly needed); the frozen requirements package, canonical contract schemas, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified. R2-1/R2-2/R2-4/R2-5 are out of scope.

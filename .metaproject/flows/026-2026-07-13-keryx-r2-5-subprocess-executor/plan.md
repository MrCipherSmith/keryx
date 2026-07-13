# Implementation Plan — Flow 026 (Release 2 · R2-5 real-subprocess executor)

Status: frozen scope (R2-5 only) — Release 2 (last wave)

## Approach

Add `src/harness/process/` — a `ProcessAdapter` port + `runContainedProcess` enforcement
function + a deterministic fake adapter + a thin real `node:child_process` adapter behind a
capability flag — closing the RUNTIME half of `SC_R04_SHELL_CONTAINMENT` (F-1). Test-first,
composing W10 `guardAction`/`actionFingerprint`/`ExecutionReceipt`, W12 `inheritBudget`, and
W7 evidence. The offline suite exercises ONLY the fake adapter (no real spawn); the real
adapter is gated by `allowRealSubprocess` and never runs in CI (W14 precedent). Reuse-only;
deterministic (injected id/clock); deps `{}` (child_process is stdlib).

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

1. T1: R2-5 scope + SC_R04_SHELL_CONTAINMENT runtime half + F-1 + reuse surface (context.md).
2. T5 (RED): `src/harness/process/executor.test.ts` (+ a flag-gated, CI-skipped live smoke
   `real-process-adapter.smoke.test.ts`) — OFFLINE, injected id/clock + a scripted fake
   `ProcessAdapter`. Cover, each fail-closed:
   - **approved allowlist happy path** — approved argv+env, clean in-bounds exit →
     `{kind:"completed"}` with a schema-valid receipt + non-empty evidenceRefs; the command
     ran in the approved cwd.
   - **timeout** — the scripted observation exceeds the reserved deadline → `{kind:"timeout"}`,
     the adapter killed the process-group, outcome is NOT `completed`/success, a receipt records
     the timeout.
   - **output-overflow** — output beyond `outputLimitBytes` → `{kind:"output-overflow"}`,
     bounded, NOT success, no unbounded-retry signal.
   - **cancellation** — external `cancelled` → `{kind:"cancelled"}`, group killed, NOT success.
   - **unapproved argv/env (fail-closed)** — argv not in the allowlist / a non-allowlisted env
     var / an injection attempt → `{kind:"blocked"}`, and the fake adapter's `spawn` was NEVER
     called (assert a spy/counter = 0).
   - **budget breach** — a reserved runtime exceeding the parent remaining → blocked (reuse
     `inheritBudget` fail-closed); adapter never spawned.
   - **spawn-error / ambiguous observation** — non-success (blocked), never a false `completed`.
   - **no-orphan** — the kill path targets the whole group (assert the fake records a
     group-kill, not just the leader).
   - **determinism** — same input + deps twice → deep-equal outcome.
   - **live smoke (flag-gated, NOT in CI)** — only when `allowRealSubprocess` + an env flag are
     set: a trivial real `node:child_process` command runs and a real timeout kills the group.
     Skipped by default.
3. T6 (GREEN): `src/harness/process/{executor,fake-process-adapter,real-process-adapter}.ts`
   composing W10/W12/W7. The real adapter is only constructed behind `allowRealSubprocess`.
   Make T5 green.
4. T7 (review): allowlist fail-closed (adapter never spawns on an unapproved argv/env — the
   security core); every bound hit (timeout/overflow/cancel) is a recorded NON-success (adversarial:
   can any bound hit report `completed`?); budget breach fail-closed; no-orphan (group kill);
   D-02 (no flow.json write); the real adapter is unreachable without the flag AND not exercised by
   the offline suite (grep the suite for a real spawn); reuse-only (W10/W12/W7/W8 unmodified or
   additive); determinism (no Date.now/Math.random; no real spawn in CI); deps `{}` (child_process
   stdlib, no framework); frozen pkg + canonical schemas + src/eval + src/contracts + ADRs untouched;
   secrets never logged.
5. `keryx health run`; confirm ACs; completion (option B) + PR (no co-authorship). NOTE: resolve the
   runbook Release 2 Стейт conflict with R2-2 (#27) + R2-3 (#28) at merge (keep all ✅). This CLOSES
   Release 2 — provide the final R2-1…R2-5 summary.

## Verification

Gate: `tsc` clean; full `bun test` ≥1254 + new green (the offline suite; the live smoke is skipped);
an approved command completes in-bounds, a timeout/overflow/cancel is a terminal NON-success with a
receipt, an unapproved argv/env NEVER spawns the adapter, a budget breach is blocked, the group is
killed on timeout/cancel (no orphan); the executor writes no flow.json; deterministic; the real
adapter never runs in CI; no new dependency.

## Risks

- **A bound hit reports success** → each non-`completed` observation maps to a terminal non-success
  outcome + receipt; T5/T7 assert timeout/overflow/cancel are never `completed` (mirrors Release 0
  SC_R04_TOOL_TIMEOUT "does not report successful completion").
- **An unapproved argv/env spawns the process** → allowlist (`guardAction`/`actionFingerprint`)
  checked BEFORE the adapter; a deny → blocked, adapter never called; T5 asserts spawn-count 0.
- **Real spawn leaks into the offline suite / CI** → the real adapter is only constructed behind
  `allowRealSubprocess`; the offline suite uses only the fake; the live smoke is env-flag-gated and
  skipped; T7 greps the suite for a real spawn.
- **Orphaned child processes** → the kill path targets the process-group (`detached:true` +
  `kill(-pid)`); T5 asserts a group-kill.
- **Budget over-run** → reuse W12 `inheritBudget` fail-closed to bound the deadline; T7 adversarial.
- **Rewriting W10/W12/W7/W8** → reuse-only/additive; if a real refactor seems needed, STOP.
- **New dep / non-determinism** → `node:child_process` is stdlib (deps `{}`); injected id/clock;
  the fake adapter is pure/scripted; no Date.now/Math.random.
- **flow.json write / secrets in logs** → the executor returns an outcome (no flow write); T7 greps
  writeFlow/flow.json = 0; secrets (env values) never logged/persisted.
- **Wrong-worktree / index-guard** → guard directives in every dispatch.

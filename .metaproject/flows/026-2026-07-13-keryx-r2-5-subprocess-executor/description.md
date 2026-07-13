# Flow 026 — Release 2 · Wave R2-5: real-subprocess executor (closes F-1 / SC_R04 live enforcement)

Status: formalized
Source: user runbook prompt (Release 2, Wave R2-5 — last wave). Frozen scope from
`docs/decisions/keryx-harness/E-03-release1-handoff.md` §4 AC-R2-5.

## Problem

Release 1 (W10, `8ed5373`) built only the **structural** half of
`SC_R04_SHELL_CONTAINMENT` (`acceptance.feature:422`): an approved argv + env
allowlist, an action fingerprint, shell-injection denial, approval-gating, and
fail-closed isolation. Its **runtime** half — *"When the process-group command
runs / Then timeout, output, cwd, and cancellation controls are enforced"* — has
NO implementing executor, because Release 1 ships no real subprocess adapter
(mutation runs through a fake/injected `MutationAdapter`, per D-04/W10 posture).
This is E-02 finding **F-1** (P2, disclosed in E-01's deferred list), the one
disclosed Release 1 structural gap, and the first item of the Release 2 track.
R2-5 introduces a **real-subprocess executor** behind a port (mirroring W14's
thin real provider), enforcing the runtime controls, while keeping the whole
test suite offline and deterministic.

## Scope (frozen: E-03 §4 AC-R2-5) — SC_R04_SHELL_CONTAINMENT runtime half

**SC_R04_SHELL_CONTAINMENT** (`acceptance.feature:422`, `@R4 @R15 @release-1`,
task M-01):
"Given a future shell tool has an approved argv and environment allowlist /
When the process-group command runs / Then timeout, output, cwd, and
cancellation controls are enforced."

Runtime enforcement to implement (each fail-closed — a bound hit NEVER reports
successful completion, mirroring the Release 0 `SC_R04_TOOL_TIMEOUT` /
`SC_R04_TOOL_OUTPUT_OVERFLOW` precedents):
- **timeout / deadline** — a command exceeding its reserved runtime is killed
  (process-group) → terminal `timeout` evidence, not success.
- **output-limit** — output beyond its byte/token limit → a bounded overflow
  result, no unbounded context-retry loop.
- **cwd** — the command runs in the approved worktree cwd (bounded).
- **cancellation** — an external cancel (AbortSignal-like) kills the
  process-group → terminal `cancelled` evidence.
- **no-orphan** — kills the whole process-group, not just the leader.
- **argv/env allowlist** — only an approved argv + env allowlist runs (reuse W10
  guard/fingerprint); anything else is blocked fail-closed, the adapter never
  spawns.

## Split (pre-approved in the prompt — W14 precedent)

Real process spawning is inherently non-deterministic, so it CANNOT live in the
offline suite. Following W14 (a thin real provider present in the tree but the
suite stays offline via a fake, live call behind a capability flag never in CI):
- **In scope now (deterministic, offline):** a `ProcessAdapter` port + the
  enforcement function `runContainedProcess` + a **fake process adapter** (like
  `FakeProvider`) + full test coverage of every enforcement path.
- **Thin real adapter behind a capability flag:** a `node:child_process` (stdlib,
  no dependency) implementation, gated by an explicit opt-in
  (`allowRealSubprocess`), NEVER constructed/exercised by the offline suite; a
  live smoke is flag-gated and excluded from CI.

## Expected Outcome

- New `src/harness/process/`:
  - `executor.ts` — `ProcessAdapter` port (the sole side-effecting boundary, like
    W10 `MutationAdapter`) + `runContainedProcess(input, deps)`: validates the
    argv/env allowlist (reuse W10 `guardAction`/`actionFingerprint`), bounds the
    deadline from the reserved budget (reuse W12 `inheritBudget`), invokes the
    adapter exactly once, and classifies the observation into a typed outcome
    (`completed` | `timeout` | `output-overflow` | `cancelled` | `blocked`),
    recording a schema-valid `ExecutionReceipt` (reuse W10/W8) + W7 evidence.
  - `fake-process-adapter.ts` — a deterministic, scripted `ProcessAdapter` (no
    real spawn) for the offline suite.
  - a thin real `node:child_process` adapter behind the `allowRealSubprocess`
    capability flag (process-group `detached:true` + `kill(-pid)`), never in CI.
- Result: a bound hit (timeout/overflow/cancel) is a terminal non-success outcome
  with evidence; only a clean in-bounds exit is `completed`. Deterministic
  (injected id/clock + fake adapter).

## Out of Scope (do NOT touch)

- R2-1…R2-4 (done). No new dependency (`dependencies` stays `{}`), no framework —
  `node:child_process` is stdlib. No REAL spawn / fs mutation in the offline
  suite. The executor NEVER writes flow.json — the parent owns completion via the
  W11 ManagedFlowPort (D-02). Deterministic (injected id/clock; no
  `Date.now`/`Math.random`).
- Rewriting W10 `guardAction`/`actionFingerprint`/`executeGuardedMutation`,
  `ExecutionReceipt` (W8 recovery), W12 `inheritBudget`, or W7 evidence — REUSE
  them (composition/additive only). If a prior module seems to need a real
  refactor, STOP and report.
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/`
  + `src/contracts/` — read/cite only. Commits/PR carry NO co-authorship trailer.
- Fail-closed: an unapproved argv/env, a budget breach, or an ambiguous
  observation denies / does not report success.

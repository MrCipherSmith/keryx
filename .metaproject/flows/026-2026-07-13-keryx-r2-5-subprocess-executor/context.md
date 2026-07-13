# Context — Flow 026 (Release 2 · R2-5 real-subprocess executor)

Collected by `keryx flow init` and enriched. (T1 context.) Release 2, Wave R2-5 — last wave.

## Baseline
- Branch `feature/keryx-release2-subprocess-executor` from `main` (R0+R1+R2-1+R2-4;
  R2-2 PR #27 + R2-3 PR #28 in-flight, NOT needed — R2-5 is independent). `bun test`
  = 1254 pass / 0 fail; `tsc` clean; deps `{}`.
- Flow renumbered 024→026 (024 collides with R2-2's unmerged flow, 025 with R2-3's).

## Frozen scope (E-03 §4 AC-R2-5) — SC_R04_SHELL_CONTAINMENT runtime half
`acceptance.feature:422` (@R4 @R15 @release-1, task M-01): "Given a future shell tool
has an approved argv and environment allowlist / When the process-group command runs /
Then timeout, output, cwd, and cancellation controls are enforced." Release 1 built only
the STRUCTURAL half (W10 `8ed5373`: allowlist/fingerprint/injection-denial/approval/
fail-closed-isolation). R2-5 = the RUNTIME executor. This is E-02 F-1 (P2), the first
Release 2 item; independent of R2-1…R2-4.
Precedent for fail-closed bound-hits: Release 0 `SC_R04_TOOL_TIMEOUT` (feature:98 —
"records a typed timeout or cancelled execution / does not report successful completion")
and `SC_R04_TOOL_OUTPUT_OVERFLOW` (feature:106 — "bounded overflow result / does not enter
an unbounded context retry loop").

## Reuse surface (compose/additive; do NOT rewrite)
- **W10 mutation** `src/harness/mutation/`:
  - `execute.ts` — `MutationAdapter` (the injected side-effecting boundary: `apply(spec)
    → {outcome; observedHash}`), `executeGuardedMutation(input, deps): ExecuteOutcome`
    (fail-closed gate order: read-only → isolation → guard.deny → approval → adapter once
    → receipt); `ExecuteDeps {clock; idSeq}`. **Pattern to mirror for the process port.**
  - `guard.ts` — `GuardOutcome = {kind:"allow"}|{kind:"deny";reason}`, `GuardInput`,
    `guardAction(input, deps): GuardOutcome` (structural argv/env/injection guard).
  - `fingerprint.ts` — `ActionSpec {path; argv: string[]; env: Record<string,string>}`,
    `ActionFingerprintOptions {worktreeRoot; envAllowlist: string[]}`,
    `actionFingerprint(spec, opts): string` (deterministic sha256; env filtered to
    allowlist + sorted; argv verbatim; path normalized to worktreeRoot). **This IS the
    "approved argv + environment allowlist" primitive.**
- **W8 recovery** `src/harness/resume/recovery.ts`: `ExecutionReceipt {schemaVersion;
  receiptId; executionId; idempotencyKey; inputHash; observedAt; outcome; evidenceRefs}`.
  Reuse this receipt shape (as W10 does) for the process receipt.
- **W12 isolation** `src/harness/child/isolation.ts`: `inheritBudget(childReq,
  parentRemaining): {ok:true; reservation}|{ok:false; reason}`, `BudgetReservation
  {reservationId; maxRuntimeMs; maxToolCalls?}`, `ParentRemainingBudget {maxRuntimeMs;
  maxToolCalls?}`. `maxRuntimeMs` bounds the process deadline (fail-closed on breach).
- **W7 evidence** `src/harness/evidence/types.ts`: `EvidenceRecord {schemaVersion;
  evidenceId; causal; kind; artifact; provenance; recordedAt}`; `EvidenceKind` includes
  `"receipt"`, `"tool-result"`, `"custom"`. Build a per-execution evidence record.
- **W11 flow-port** `src/harness/flow/managed-flow-port.ts`: parent owns completion; the
  executor never writes flow.json (D-02).
- **W14/W20 precedent** `src/harness/provider/anthropic/` + `fake-provider.ts`: thin real
  adapter (no SDK, deps {}) behind a capability flag; suite stays offline via a fake; live
  call never in CI. R2-5 mirrors this for `node:child_process`.

## Integration map — `runContainedProcess(input, deps)`
- `input = { command: ContainedCommand; allowlist: {worktreeRoot; envAllowlist}; budget:
  BudgetReservation (or reserved deadlineMs); outputLimitBytes; cancelled?: boolean;
  adapter: ProcessAdapter; <parent context for evidence/receipt> }`, where
  `ContainedCommand` reuses/extends `ActionSpec` (path/argv/env) + cwd.
- **ProcessAdapter port** (sole side-effecting boundary; fake in tests, real behind flag):
  `spawn(command): ProcessObservation` (fake returns a scripted observation:
  exit-in-bounds / deadline-exceeded / output-overflow / cancelled / spawn-error). The
  real adapter uses `child_process.spawn({detached:true, cwd})` + `process.kill(-pid)` for
  the group; NEVER constructed unless `allowRealSubprocess` is granted; not in CI.
- **Enforcement order (fail-closed, adapter consulted at most once):**
  1. argv/env allowlist — compute `actionFingerprint` + `guardAction`; a deny (unapproved
     argv / non-allowlisted env / injection) → `{kind:"blocked"}`, adapter NEVER spawned.
  2. budget — `inheritBudget` bounds the deadline; a budget-breach request → blocked.
  3. spawn once via the adapter (in the approved cwd).
  4. classify the observation → typed outcome:
     - clean in-bounds exit → `completed` (receipt + evidence);
     - deadline exceeded → `timeout` (adapter killed the group) — NOT success;
     - output past `outputLimitBytes` → `output-overflow` — NOT success, no retry loop;
     - external `cancelled` → `cancelled` (group killed) — NOT success;
     - spawn-error / ambiguous → blocked / non-success.
  Result: `ContainedProcessOutcome = {kind:"completed"; receipt; evidenceRefs} |
  {kind:"timeout"|"output-overflow"|"cancelled"; receipt} | {kind:"blocked"; reason}`.
  Every non-`completed` terminal outcome is a recorded non-success (evidence/receipt).

## D-02 / security
- The executor NEVER writes flow.json; the parent owns completion via ManagedFlowPort. An
  unapproved argv/env can't spawn; a budget breach / bound hit / ambiguous observation →
  non-success. Kills the whole process-group (no-orphan). apiKey/secrets never logged.

## Target modules
- `src/harness/process/executor.ts` (NEW) — `ProcessAdapter`, `ContainedCommand`,
  `ContainedProcessOutcome`, `runContainedProcess`.
- `src/harness/process/fake-process-adapter.ts` (NEW) — deterministic scripted adapter.
- `src/harness/process/real-process-adapter.ts` (NEW) — thin `node:child_process`, behind
  the `allowRealSubprocess` flag, never in CI.
- Additive helper to mutation guard/fingerprint ONLY if strictly needed — prefer none.

## Decisions (approved in the prompt)
- Split pre-approved: port + fake adapter offline NOW; thin real `node:child_process`
  adapter behind a capability flag, live smoke never in CI (W14 precedent). deps `{}`
  (child_process is stdlib — no framework). Deterministic (injected id/clock). Fail-closed.
  D-02. No co-authorship.
- TDD: RED (Sonnet) → impl (Opus highload) → review (Opus highload/security).

## Operational
- keryx = `bun ./src/cli.ts`. Root = `/Users/Goodea/goodea/keryx` (branch
  feature/keryx-release2-subprocess-executor). Never commit to main; PR at the end (no
  co-authorship). NOTE: R2-5 edits the runbook Release 2 Стейт → will conflict with R2-2
  (#27) + R2-3 (#28) at merge; resolve then (keep all ✅).
- State only via `keryx flow` (flow 026); workers via subagent-dispatch/result (STATUS:
  first line). WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx && pwd`
  first, write ONLY under it. Injected id/clock; NO real spawn/fs/network in the offline
  suite; `.toThrow()`/deep-equal for immutability. Order: T5 (RED) → T6 (impl) → T7 (review).

# Multi-Agent Engine — Implementation Plan
Version: 0.4.0

> **Status note:** **all phases A → B → C → D shipped** as flows 088–101
> (phases A–C) and flow 171 (phase D), including the originally-deferred
> cost-dimension hook in the budget ledger (flow 101). The plan below is
> retained as the original phased record; see `README.md` for the per-phase
> runtime evidence and the two minor items still open (live `keryx agents`
> snapshot; dedicated `orchestrator-state` fold).

Phased plan. **Phases 1–3 are the recommended first slice (Option B + caps);
Phases 4–6 are the roadmap (Option C).** (Historical note: at the time this plan
was first written, no runtime existed yet for Phases 1-6 — that is no longer
true, see the status note above; Phase D below is in that same
not-yet-implemented state as of 0.3.0.)

## Phase 1 — `resolveChildModel` (core, S)

- **New:** `src/harness/child/model.ts` — `resolveChildModel(parent, request,
  deps)` per specification. Pure; result idiom mirrors `inheritBudget`.
- **New:** `src/harness/child/model.test.ts` — resolution order (env → explicit →
  tier → inherit); gates G1 (allowlist), G2 (trust/network), G3 (unknown);
  determinism (same input → deep-equal).
- **New:** a small `providerClass(id)` classifier derived from
  `OPENAI_COMPAT_PROVIDERS` (`src/commands/providers.ts`) + `anthropic`/`ollama`.
- **Acceptance:** AC1, AC2 (resolution side), AC5 (composition order).

## Phase 2 — Contract & spawn threading (core, S)

- **Edit:** `subagent-dispatch.schema.json` — add optional `model` block
  (see `schemas/child-model-selection.schema.json`).
- **Edit:** `harness-child-contract-extension.schema.json` +
  `src/harness/child/contract.ts` — add optional `modelSelection`
  (`buildChildDispatchExtension` conditional-spread, like `maxToolCalls`).
- **Edit:** `src/harness/child/spawn.ts` — `SpawnChildRequest.modelRequest?`,
  `SpawnChildInput.parentModel` + `allowedProviders`/`credentialGrant`; call
  `resolveChildModel` after the policy gate; stamp `modelSelection` on the
  extension; deny on `!ok` (existing `{ok:false,reason}` shape).
- **Tests:** extend `spawn.test.ts` — model denial refuses the whole spawn (no
  partial extension); inherit path is default.
- **Acceptance:** AC5, AC7 (backward compatibility).

## Phase 3 — Caps, ledger, run threading, quarantine (core, S–M)

- **New:** `RemainingBudgetLedger` (run-scoped) wrapping `planWaves` + ad-hoc
  `spawnChild`; depth cap from `taintIds.length`; `maxChildrenPerRun` counter.
  Likely `src/harness/child/ledger.ts` + tests (property test for aggregate
  non-over-grant across waves + ad-hoc).
- **Edit:** `src/harness/parallel/scheduler.ts` — `ChildTask.modelRequest?`
  (carried through; budget fold unchanged).
- **Edit:** `src/harness/run/run.ts` — build the child `NormalizedRequest` from
  `extension.modelSelection`; construct provider via credential-scoped
  `makeProvider` (make `_model` live).
- **Edit:** `src/harness/provider/make-provider.ts` — accept a `CredentialGrant`
  instead of ambient `process.env` for child construction; still fail-closed, but
  denial is surfaced by the resolver, not silent `FakeProvider` on the orchestrated
  path.
- **New:** quarantine scan on child summary before re-dispatch (reuse existing
  redaction/instruction-pattern utilities where present).
- **Acceptance:** AC3, AC6.

## Phase 4 — Monitoring fold + `keryx agents` (roadmap C, M)

- **New:** `reduceAgents(events) → AgentsSnapshot` (pure) + tests (AC4 stable
  hash). Usage sums only exact provider-reported tokens.
- **New:** `keryx agents [--json]` command surfacing the fold; TUI tree in the
  display layer only.
- **Edit:** `agent-event` schema — `model_resolved` (used here for audit).
- **Acceptance:** AC4.

## Phase 5 — Adaptive escalation (roadmap C2, M)

- Model ladder on the dispatch; deterministic escalation predicate over
  `CanonicalSubagentResult`; each rung a new `attempt.number` on the same
  `branchId`; `tier_escalated` events; ladder self-truncates against the ledger.
- Keyword/complexity classifier for the *initial* rung only (pure).

## Phase 6 — Event-sourced fleet, worktrees, peer messaging (roadmap C3, L)

- `orchestrator-state` as a pure fold over `agent-event` (`reduceState`);
  crash-safe resume via existing `src/harness/resume/` + `replay/`.
- Git-worktree isolation for parallel mutating children (`EnterWorktree`/
  `ExitWorktree` + `ContainedCommand.cwd` seam); explicit post-wave merge.
- Bounded `peer_message` (artifact-refs only, policy-gated) as an event
  projection; per-child message quota in the budget lattice to prevent loops.

## Phase D — Concurrent waves + structured status (implemented, flow 171)

Added 2026-08-18, shipped as flow 171 (tasks T5–T7). Additive to A–C; no rework
of shipped contracts.

- **D1a — Wave executor:** `src/harness/parallel/scheduler.ts` — add
  `executeWaves(tasks, waves, deps)` next to `planWaves` (spec §D1). Pure
  wave-order enforcement, concurrent-within-wave via `Promise.all`; failures
  are values, never thrown across the boundary (a rejected child settlement
  must not abort its siblings — use `Promise.allSettled` internally if `run`
  itself can reject, even though the D2 contract makes rejection unlikely for
  the intended caller).
- **D1b — Turn-loop integration:** `src/commands/agent.ts` — in the tool-call
  batch handler (~line 1192-1238), detect 2+ `spawn_subagent` calls in the same
  batch, build `ChildTask[]` (no `dependsOn`; `taskId` = the tool-call id),
  call `planWaves` with a new `maxConcurrency` config field, run
  `executeWaves`, splice results back into the batch's per-call results in the
  model's original call order (order of RESULTS returned to the model must
  match order of CALLS made — concurrency changes execution order, not
  reporting order). Every other tool type's handling is untouched.
- **D1c — Concurrency cap:** `AgentDeps.maxSubagentConcurrency` (new, optional,
  default 3 — see spec §D1 for why not a fixed number and why no config-file
  wiring yet). Threaded the same way `maxTreeDepth`/`maxChildrenPerRun` already
  are (hardcoded constant, not config-loaded).
- **D2a — Thread the internal finish reason out:** `src/commands/agent.ts` —
  `runAgentTurn`'s return value gains an internal (not model-facing)
  `finishReason?: "budget" | "no-progress"` field, set exactly where
  `finishWithBudgetSummary` (~line 1349) and the existing no-progress detector
  (~line 1318) already fire — no new detection, just surfacing what's already
  computed.
- **D2b — Consume it in the tool:** `src/harness/tool/builtin/spawn-subagent-tool.ts`
  — the success-path branch (~line 844-872) checks the child turn's
  `finishReason` before building its return value; maps `"budget"` →
  `status:"BudgetExhausted"`, `"no-progress"` → `status:"NoProgress"`,
  otherwise `status:"Completed"`. The existing timeout (~812-840) and thrown-error
  (~873-888) branches gain `status:"Timeout"`/`status:"Error"` respectively (a
  label added to an already-correct branch, not new logic); the MAE-denial
  branch (`spawned.ok === false`) gains `status:"Denied"`.
- **Tests:** `scheduler.test.ts` extension for `executeWaves` (AC9, AC10 via
  fake/injected clocks — no real `setTimeout` sleep in the test suite);
  `spawn-subagent-tool.test.ts` extension for AC11 (one test per status value,
  including the two that are net-new: `BudgetExhausted`, `NoProgress`);
  `agent.test.ts` extension for AC12 (regression: no `status` field read ⇒
  identical observable behavior to pre-Phase-D).
- **Acceptance:** AC9, AC10, AC11, AC12.

## Cross-cutting constraints

- **Zero dependencies (NFR3):** any provider SDK / observability lib →
  `optionalDependencies` + dynamic `import()` + fallback + ADR + AC15 pin. The
  fold and resolvers are hand-rolled and dep-free.
- **Determinism (NFR2):** all core modules take injected `clock`/`idSeq`; no
  `Date.now`/`Math.random`; replay `expectedStateHash` stays stable.
- **D-02:** children never write flow state; the parent advances the flow from
  evidence.

## Suggested sequencing

Phases 1 → 2 → 3 are independently shippable and deliver the user's core ask
(explicit-or-inherit model + safe management). Phase 4 adds observability. Phases
5–6 land on the contracts frozen in 1–2, so no rework. A `keryx flow` package can
track this with frozen acceptance criteria per phase.

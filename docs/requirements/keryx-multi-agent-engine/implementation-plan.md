# Multi-Agent Engine — Implementation Plan
Version: 0.1.0

Phased plan. **Phases 1–3 are the recommended first slice (Option B + caps);
Phases 4–6 are the roadmap (Option C).** No runtime is implemented yet; this is a
plan, not a status claim.

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

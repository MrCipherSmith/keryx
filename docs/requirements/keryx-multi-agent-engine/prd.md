# Multi-Agent Engine — Product Requirements
Version: 0.1.0

## Problem

Keryx's harness can already spawn a bounded child attempt with fail-closed
**budget** and **policy** inheritance (`src/harness/child/spawn.ts`,
`isolation.ts`), fan children out into concurrency- and budget-bounded waves
(`parallel/scheduler.ts`), and fold a canonical `subagent-result` back into
parent evidence. But it cannot orchestrate a real multi-agent workload because
**model and provider selection is missing on the child path**:

- `spawnChild` / `ChildContractExtension` carry no model or provider.
- `run.ts` resolves a model only at the top level
  (`input.model ?? config.defaultModel ?? "fixture-model"`, run.ts:196–197) and
  never threads one to children.
- `makeProvider(name, _model, opts)` accepts `model` but **ignores it** and
  **fails open to `FakeProvider`** when a credential is missing — for an
  orchestrated child that means it silently "succeeds" doing nothing.

Model/provider is therefore an unconstrained privilege and cost axis: a child
could name any provider (a different one from its parent), request the most
expensive model, or probe which credentials exist in `process.env` — none of the
existing guards say no. This is a fail-open hole in the "a role cannot escalate"
invariant (SC_R08 / ADR-0004) that budget/policy inheritance otherwise upholds.

## Goal

Give the orchestrator **full, safe control over subagents**: launch children
with an explicitly chosen **or** parent-inherited model/provider, bound their
depth/count/budget, monitor them deterministically, and fold their results back —
all fail-closed, deterministic, and dependency-free, consistent with the existing
harness.

## Users

- **Orchestrator agents** (Flow Reviewer, flow-orchestrator, review-orchestrator,
  docpack/autodoc orchestrators) that dispatch specialized subagents.
- **Keryx harness / CLI** driving the parent run and rendering monitoring.
- **Skill / worker authors** who declare a subagent's role, model, and allowed
  actions via the dispatch contract.
- **Operators** observing and controlling a running fleet (`keryx agents`).

## Requirements

### Functional

- **FR1 — Explicit-or-inherit model selection.** A dispatch MAY carry a `model`
  block (`{ provider?, model? }`) or a `tier`. When omitted, the child inherits
  the parent orchestrator's `providerId`/`modelId` verbatim. This is the default.
- **FR2 — `resolveChildModel` resolver.** A pure function mirroring
  `inheritBudget`/`inheritPolicy`, returning `{ok:true, selection, source}` or
  `{ok:false, reason}`. Resolution order: env override → explicit dispatch value
  → tier map → inherit(parent).
- **FR3 — Policy-gated provider allowlist.** A child may only resolve to a
  provider in the parent's already-detected allowlist, and network providers are
  gated by the child's resolved `trustMode` / `network` capability. An
  unknown/uncredentialed/unauthorized provider is **denied at resolution** (never
  degraded to `FakeProvider`).
- **FR4 — Credential scoping.** Provider credentials are part of the policy grant
  passed into resolution, not an ambient `process.env` read that leaks key
  presence. A child cannot enumerate credentials it was not granted.
- **FR5 — Threading.** The resolved selection is stamped on
  `ChildContractExtension` and used to build the child's `NormalizedRequest` and
  provider via `makeProvider` — the one place model reaches the wire.
- **FR6 — Safety caps.** Enforce a subagent **tree-depth cap** (read from the
  provenance taint-chain length) and a **total child count cap** per run, both
  fail-closed. `spawn-subagent` remains contract-legal only within these caps.
- **FR7 — Single budget ledger.** One authority decrements a shared remaining
  budget across every spawn path (waves *and* ad-hoc `spawnChild`), so
  independent spawns cannot each see the full parent remaining and over-grant.
- **FR8 — Deterministic monitoring.** A pure accounting fold (replayable, no
  clock/RNG) produces per-child status/usage/budget-remaining; a separate display
  layer may be non-deterministic. `keryx agents [--json]` surfaces the fold.
- **FR9 — Result handling + quarantine.** Fold canonical results into evidence as
  today, but **re-scan child free-text for instruction-shaped / injection
  patterns** before the orchestrator dispatches based on it.
- **FR10 — Roadmap extension points (documented, not built now):** cost-aware
  tier escalation, event-sourced orchestrator state, worktree isolation for
  parallel mutators, bounded peer messaging.

### Non-functional

- **NFR1 — Fail-closed by default.** Any unresolved/ambiguous model, provider,
  credential, or cap is a denial, never a silent degrade.
- **NFR2 — Deterministic core.** Resolvers, fold, and caps use injected
  `clock`/`idSeq` only; no `Date.now`/`Math.random`; identical inputs → deep-equal
  output; replay fixtures (`expectedStateHash`) stay stable.
- **NFR3 — Zero runtime dependencies.** `dependencies` stays `{}`; any provider
  SDK/observability lib is `optionalDependencies` + dynamic `import()` + fallback
  + ADR + AC15 pin.
- **NFR4 — Backward compatible.** A dispatch with no `model` block behaves
  exactly as today (inherit). Existing runs and tests keep passing.
- **NFR5 — D-02 preserved.** A child never writes flow state; the parent owns
  status and completion.

## Success Criteria

- SC1: A dispatch with no `model` block runs the child on the parent's model;
  a dispatch with an allowed explicit `model`/`tier` runs on that model — both
  proven by unit tests.
- SC2: A dispatch naming an unknown/uncredentialed/unauthorized provider, or one
  a low-trust child's policy forbids, is **denied** with a reason (no
  `FakeProvider` no-op run).
- SC3: A subagent tree exceeding the depth or count cap is denied fail-closed;
  aggregate budget across all children never exceeds parent remaining.
- SC4: The monitoring fold is pure and replayable (same events → same state
  hash); `keryx agents --json` reflects it.
- SC5: Child free-text that matches instruction-shaped patterns is flagged/
  quarantined before it can steer the next dispatch.
- SC6: `npm`/`bun` dependency guard tests and determinism tests still pass.

## Risks

- **R1 — Model choice as privilege escalation (Critic Q1/Q8).** *Mitigation:*
  FR3/FR4 — policy-gated allowlist + credentials in the grant.
- **R2 — Fail-open `FakeProvider` masking a dead child (Critic Q2).**
  *Mitigation:* deny at resolution; distinguish *denied* from *degraded*.
- **R3 — Cost/tier map drift + inconsistent usage reporting (Critic Q3).**
  *Mitigation:* defer cost enforcement; document as an extension point (FR10);
  keep budget on runtime + tool-calls.
- **R4 — Combinatorial fan-out / recursion (Critic Q4/Q5).** *Mitigation:*
  depth cap from taint-chain + count cap + single shared ledger (FR6/FR7).
- **R5 — Non-deterministic monitoring breaking replay (Critic Q6).**
  *Mitigation:* split pure fold from display (FR8/NFR2).
- **R6 — Prompt injection via child output (Critic Q7).** *Mitigation:*
  quarantine/re-scan before re-dispatch (FR9).
- **R7 — Dependency-policy violation from a monitoring/SDK lib (Critic).**
  *Mitigation:* hand-rolled dep-free core (NFR3).

## Recommendation

Ship the **fourth-resolver core with the policy gate and safety caps** (options
A + B + the depth/count/ledger guards) as the first implemented slice; document
the **full A → B → C architecture** so the escalation, event-sourcing, worktree,
and peer-messaging extensions land on stable contracts without rework. Defer
cost/token budgeting to a named extension point. This is the smallest change that
makes model selection real *and* fail-closed, and it reuses the entire existing
lifecycle/scheduler/result path unchanged.

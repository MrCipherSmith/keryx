# Multi-Agent Engine — Product Requirements
Version: 0.4.0

> **Status note:** the requirements below have been **implemented** as flows
> 088–101 (see `README.md` for the runtime evidence and the two minor deferrals:
> live `keryx agents` snapshot against a running run, and a dedicated
> `orchestrator-state` fold). This PRD is retained as the original requirements
> record. **The Phase D addendum below (FR11/FR12, SC7/SC8, R8/R9) has been
> implemented as flow 171 (tasks T5–T7).**

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

## Problem (Phase D addendum, 2026-08-18)

Two gaps confirmed by direct code investigation, not present in flows 088-101:

- **No real concurrency on the interactive path.** `planWaves`
  (`parallel/scheduler.ts`) already computes bounded-concurrency,
  dependency-ordered wave plans and is unit-tested — but it is a PLANNER only;
  nothing executes a plan. `src/commands/agent.ts`'s tool-call loop processes
  every `spawn_subagent` call in a batch strictly one at a time (`await`s each
  child's entire turn before starting the next), so in practice every batch is
  one wave of size one regardless of what `planWaves` could compute. A
  three-project reference study (xAI Grok Build, OpenAI Codex CLI, sst/opencode
  — see `brainstorm.md`) found Keryx is the only one of the four studied that
  never runs sibling spawns concurrently (opencode's default dispatch path
  delegates to the Vercel AI SDK, not directly inspected in this study — see
  `brainstorm.md`'s hedge on that specific point).
- **A child's own budget exhaustion is invisible to the parent.** When a
  spawned child hits its own internal step/tool-call limit and the model never
  produces a clean finish, `spawn-subagent-tool.ts` still returns
  `isError:false` — identical in shape to a deliberate, successful completion.
  Only a parent-granted wall-clock timeout or a thrown error are currently
  distinguished. The same reference study found this distinct-status pattern
  in 2 of 3 comparators (Grok Build, Codex); opencode shares Keryx's exact gap
  for this one case.

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
- **FR11 — Bounded concurrent execution of sibling `spawn_subagent` calls
  (Phase D).** When a single model turn emits multiple `spawn_subagent` tool
  calls, they MUST be planned via the existing `planWaves` (dependency-free
  inputs from this call site ⇒ effectively one `maxConcurrency`-bounded wave)
  and executed concurrently within that wave, not one-at-a-time. Tool calls of
  OTHER types in the same batch are explicitly out of scope for this
  requirement and keep today's sequential semantics (a batch mixing
  `spawn_subagent` with e.g. `shell_exec` is not re-ordered by this
  requirement — only the run of `spawn_subagent` calls among themselves).
- **FR12 — Structured child-completion status (Phase D).** Every
  `spawn_subagent` result MUST carry a status distinguishing *why* the child
  did not cleanly complete, not just a boolean: `Completed | BudgetExhausted |
  Timeout | Denied | Error | NoProgress`. `BudgetExhausted`/`NoProgress` MUST
  be set from the child's own internal limit/no-progress path (currently
  silently folded into a false "success") without requiring the model to
  self-report it in prose.

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
- SC7 (Phase D): N sibling `spawn_subagent` calls in one turn complete in
  wall-clock time bounded by the slowest child, not the sum of all children
  (proven by a test with injected, independently-timed fake children).
  Concurrency never exceeds `maxConcurrency`, and the aggregate budget ledger
  still never over-grants across concurrently-running children (property test
  extending AC3's existing sequential-spawn coverage to concurrent spawns).
- SC8 (Phase D): a child whose own step/tool-call budget is exhausted before a
  clean finish returns `status: "BudgetExhausted"`, never `status: "Completed"`
  nor bare `isError:false`; existing timeout/error/denial paths keep returning
  their own distinct status values (no regression to `Timeout`/`Denied`/
  `Error`'s existing signal).

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
- **R8 — Concurrent children racing on shared, mutable parent state (Phase D).**
  The interactive turn loop, `RemainingBudgetLedger`, and any shared TUI fleet
  state were all written assuming one child executes at a time. *Mitigation:*
  the ledger's grant/decrement step MUST stay synchronous/atomic per
  reservation (no `await` between check and decrement) so concurrent grants
  cannot race past the shared remaining budget — verify this explicitly, do
  not assume it holds just because the ledger's existing sequential tests pass.
- **R9 — A richer status enum invites callers to over-fit retry logic to
  specific values (Phase D).** *Mitigation:* document `BudgetExhausted`/
  `NoProgress`/`Timeout` as advisory signals for the ORCHESTRATOR MODEL's own
  judgment (retry, extend, accept-partial, give up), not as a mechanical
  auto-retry the harness performs unprompted — the parent still owns the
  decision (D-02-adjacent: status enrichment is not a new authority).

## Recommendation

Ship the **fourth-resolver core with the policy gate and safety caps** (options
A + B + the depth/count/ledger guards) as the first implemented slice; document
the **full A → B → C architecture** so the escalation, event-sourcing, worktree,
and peer-messaging extensions land on stable contracts without rework. Defer
cost/token budgeting to a named extension point. This is the smallest change that
makes model selection real *and* fail-closed, and it reuses the entire existing
lifecycle/scheduler/result path unchanged.

**Phase D (2026-08-18, implemented, flow 171):** wired the already-existing
`planWaves` plan to a real concurrent executor for sibling `spawn_subagent`
calls (FR11) via `executeWaves` in `scheduler.ts` and `runConcurrentSpawnBatch`
in `agent.ts`; added the `Completed | BudgetExhausted | Timeout | Denied |
Error | NoProgress` status (FR12) via `SubagentCompletionStatus` in
`spawn-subagent-tool.ts`. Both are additive to the implemented A→B→C engine —
no contract breakage, no change to model resolution, budget/policy inheritance,
or the D-02 invariant. SC7/SC8 and R8/R9 covered by tests; two trade-offs
documented (T6 findings).

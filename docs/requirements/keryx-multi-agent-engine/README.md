# Keryx Multi-Agent / Subagent Orchestration Engine
Version: 0.4.0

## Purpose

Define the requirements for a first-class **subagent orchestration engine** in
the Keryx harness: a parent (orchestrator) agent can launch bounded child
(subagent) attempts, each with an **explicitly selected or inherited model /
provider**, manage their lifecycle and concurrency, monitor them, and fold their
results back — without breaking Keryx's fail-closed, deterministic, parent-owns-
completion invariants.

The engine closes the one authority axis the current harness does not constrain:
**model and provider selection**. Budget and policy already inherit fail-closed
(`inheritBudget`, `inheritPolicy`); model/provider currently rides in as an
unchecked string and is ignored at construction (`makeProvider(name, _model,…)`).
This package adds a fourth inheritance resolver plus the surrounding lifecycle,
monitoring, and safety machinery, documented as a phased architecture (A → B → C).

## Status

**implemented (A → B → C → D).** The A → B → C roadmap described in this package
has shipped as flows 088–101, with all eight acceptance criteria (AC1–AC8)
covered by tests in `src/harness/child/*.test.ts` and `src/harness/monitor/
reduce.test.ts`. Phase D (concurrent sibling spawns + structured completion
status, AC9-AC12) has now shipped as flow 171 (tasks T5–T7), with the wave
executor, concurrent spawn batch integration, and structured completion status
all implemented and tested.

Runtime evidence:

- **Phase A — fourth resolver:** `src/harness/child/model.ts` (`resolveChildModel`,
  `parseEnvModel`, `parseDispatchModel`, `providerClass`) — exact resolution order
  env → explicit → tier → inherit with gates G1/G2/G3 (flow 088).
- **Phase B — safety caps:** `src/harness/child/spawn.ts` threading
  `input.allowedProviders` + `maxTreeDepth` from taint-chain length
  (defaults `DEFAULT_MAX_TREE_DEPTH=3`, `DEFAULT_MAX_CHILDREN=16` in
  `orchestrate.ts:26-27`); `src/harness/child/ledger.ts`
  `RemainingBudgetLedger` (flow 090); `src/harness/child/quarantine.ts`
  `quarantineChildSummary` (flow 090).
- **Phase C1/C2 — adaptive escalation:** `src/harness/child/escalation.ts`
  (`shouldEscalate`, `escalate`, `tier_escalated` events, flow 094).
- **Phase C3 — worktrees + peer messaging:** `src/harness/child/worktree.ts`
  (`needsWorktree`, `WorktreePort` seam, flow 096); `src/harness/child/peer.ts`
  (artifact-ref-only payload, pure-fold inboxes, fail-closed admission, flow 097).
- **Monitoring fold (agents):** `src/harness/monitor/reduce.ts` (`reduceAgents`,
  `diffAgents`, pure); CLI wired as `keryx agents monitor <events-file> [--json]`
  via `src/cli.ts:150-151` → `src/commands/agents.ts`. NOTE: the actual CLI
  surface is `keryx agents monitor <events-file>` (offline fold against a captured
  events file), not the `keryx agents --json` live-snapshot form sketched in the
  spec — a deliberate drift; the spec text is retained below for history.
- **Event-sourced orchestrator-state fold:** `src/harness/monitor/reduce-state.ts`
  (`reduceState` / `initialOrchestratorState` + pure left-fold `applyEvents`,
  flow 095, Phase 6a) folds the append-only `agent-event` stream into a
  schema-valid `OrchestratorState`
  (`.metaproject/core/gdskills/contracts/orchestrator-state.schema.json`),
  giving crash-safe resume, deterministic replay, and a live projection — covered
  by `src/harness/monitor/reduce-state.test.ts`.
- **Dispatch contract extensions:** `model` block added to
  `.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json:85-91` and
  `modelSelection` on `ChildContractExtension` at `src/harness/child/contract.ts:42`
  (flow 089).
- **Spawn facade:** `src/harness/child/orchestrate.ts` `spawnSubagent`
  (integration, flow 091).
- **Cost/token budget hook (documented as "deferred" → now landed):** the
  `maxCostUnits` dimension is present in the ledger (flow 101, covered by
  `ledger.test.ts` AC3). This was listed in the original Non-goals as a deferred
  extension point; it has since been implemented as an optional hook.

Genuinely remaining (not implemented): an in-process live event tap that would
let `keryx agents` produce a live snapshot against a *running* run — today both
folds (`reduceAgents` and `reduceState`) operate on a captured events file, not a
live in-process stream.

**Phase D — implemented (added 2026-08-18, shipped flow 171).** Two gaps found by
direct code investigation while comparing Keryx against three reference
open-source coding agents (xAI Grok Build, sst/opencode, OpenAI Codex CLI — see
`brainstorm.md` for the comparison) have now been closed:

1. **Interactive `spawn_subagent` calls in one turn now run concurrently.** The
   tool-call loop in `src/commands/agent.ts` now detects batches of 2+ 
   `spawn_subagent` calls and runs them concurrently via `executeWaves` instead
   of serializing each one. This reuses the existing `planWaves` planner to
   compute `maxConcurrency`-bounded, dependency-ordered waves, then executes
   them with a new `executeWaves` executor function.
2. **A child that exhausts its own internal step/tool-call budget now returns a
   distinct status.** `spawn-subagent-tool.ts` now returns a `status` field 
   distinguishing six completion reasons: `Completed | BudgetExhausted | 
   Timeout | Denied | Error | NoProgress`. `BudgetExhausted` and `NoProgress`
   are newly surfaced from `agent.ts`'s existing internal detectors; the parent
   can now act on these distinct outcomes instead of seeing only `isError`.

Runtime evidence:

- **Phase D — concurrent waves:** `src/harness/parallel/scheduler.ts`
  (`executeWaves`, `WaveExecutorDeps<TTask,TResult>`, `WaveExecutionError{
  waveIndex, failedTaskIds, causes}`) + tests in `scheduler.test.ts` (flow
  171 T5); `src/commands/agent.ts` integration via `runConcurrentSpawnBatch`
  with `AgentDeps.maxSubagentConcurrency` (default 3, on `AgentDeps` not
  `HarnessRunConfig` — unlike the original spec sketch, no env/config-file
  wiring yet, same deferred state as `maxTreeDepth`/`maxChildrenPerRun`) (T6).
- **Phase D — structured completion status:** `SubagentCompletionStatus` type
  (`"Completed"|"BudgetExhausted"|"Timeout"|"Denied"|"Error"|"NoProgress"`) +
  `StructuredSubagentResult{status, output, isError, partial?}` added to
  `src/harness/tool/builtin/spawn-subagent-tool.ts` (T7); backward compatible
  (isError still present, derived from status). `finishReason` threaded out of
  `RunAgentTurnResult` from `runAgentTurn` in `agent.ts` to map `"budget"` →
  `BudgetExhausted` and `"no-progress"` → `NoProgress`.
- **Concurrency safety:** PRD R8 ledger race verified already safe by
  construction (synchronous grant path, no `await` between check and decrement);
  regression test in `ledger.test.ts` (T5).
- **Test results:** `bun test` 4153 pass / 0 fail (flow 171 T7 report).

Builds on the existing harness primitives in `src/harness/` (child spawn +
isolation + contract, `planWaves` scheduler, provider port, canonical
`subagent-dispatch`/`subagent-result`/`agent-event`/`orchestrator-state`
contracts).

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, scope, status, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Identity, data contracts, resolver semantics, CLI/skill surface, acceptance criteria. |
| [agent-protocol.md](agent-protocol.md) | Subagent behavior: spawn, model resolution, caps, result/quarantine, monitoring events. |
| [brainstorm.md](brainstorm.md) | Decision history: reference designs studied, options, critical questions, resolved forks. |
| [implementation-plan.md](implementation-plan.md) | Phased A → B → C plan with file touch-points and effort. |
| [schemas/child-model-selection.schema.json](schemas/child-model-selection.schema.json) | Machine-readable model-selection block on the dispatch contract + resolved extension field. |
| [schemas/agent-event-extensions.schema.json](schemas/agent-event-extensions.schema.json) | New `agent-event` types: `model_resolved`, `tier_escalated`, `peer_message`. |

## Scope

**In scope**
- A pure, fail-closed **`resolveChildModel`** resolver (explicit-or-inherit),
  gated by a parent **provider allowlist** and the child's resolved policy.
- An optional **`model` block on `subagent-dispatch`** as the agent-definition
  surface (no new file format).
- Threading the resolved selection through `spawnChild` → `ChildContractExtension`
  → the child's `NormalizedRequest` / `makeProvider`.
- **Safety caps**: subagent tree depth, total live/emitted child count, and a
  single shared budget ledger across every spawn path.
- **Monitoring**: a deterministic accounting fold plus a non-deterministic
  display layer, and a `keryx agents --json` surface.
- **Result handling**: canonical result folding + injection quarantine of child
  free-text before the orchestrator acts on it.
- **Roadmap (C)**: adaptive cost-aware model escalation, event-sourced
  orchestrator state, git-worktree isolation for parallel mutators, bounded peer
  messaging — documented with extension points.
- **Roadmap (D), added 2026-08-18**: bounded concurrent execution of sibling
  `spawn_subagent` calls within one interactive turn (wiring `planWaves`'s
  existing wave PLAN to a real wave EXECUTOR — no new scheduling algorithm), and
  a structured child-completion status distinguishing *why* a child did not
  finish cleanly (budget exhausted, timed out, denied, errored, no progress) so
  the parent can decide retry vs. extend vs. accept-partial instead of only
  seeing `{output: string, isError: boolean}`.

**Non-goals (this release)**
- Token/dollar **cost budgeting enforcement** — the budget lattice stays
  runtime + tool-calls; a cost dimension is a documented extension point only
  (providers report usage inconsistently; see PRD risk R3).
- A separate `.claude/agents/*.md`-style loader — the dispatch contract is the
  definition surface.
- Any relaxation of the D-02 invariant (a child never writes flow state).
- New runtime dependencies — the zero-`dependencies` policy holds; any optional
  provider SDK follows the optional-deps + dynamic-import + ADR + AC15 rule.

## Related Modules

- **Project Agent Harness** (`docs/requirements/keryx-project-agent-harness/`) —
  the provider protocol, session, budget, policy, and child-contract this engine
  extends.
- **Execution Observability** (`docs/requirements/keryx-execution-observability/`)
  — provenance, per-run evidence, retry taxonomy the monitor reuses.
- **Metaproject-Native Harness** (`docs/requirements/keryx-metaproject-native/`)
  — the `MetaprojectPort` and universal Task Manager that dispatch subagents.
- **Flow Reviewer** (`docs/requirements/flow-reviewer/`) — a concrete consumer
  that already anticipates adaptive model routing over subagents.

# Keryx Multi-Agent / Subagent Orchestration Engine
Version: 0.2.0

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

**implemented** — the A → B → C roadmap described in this package has shipped as
flows 088–101, with all eight acceptance criteria (AC1–AC8) covered by tests in
`src/harness/child/*.test.ts` and `src/harness/monitor/reduce.test.ts`.

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
- **Monitoring fold:** `src/harness/monitor/reduce.ts` (`reduceAgents`,
  `diffAgents`, pure); CLI wired as `keryx agents monitor <events-file> [--json]`
  via `src/cli.ts:150-151` → `src/commands/agents.ts`. NOTE: the actual CLI
  surface is `keryx agents monitor <events-file>` (offline fold against a captured
  events file), not the `keryx agents --json` live-snapshot form sketched in the
  spec — a deliberate drift; the spec text is retained below for history.
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
let `keryx agents` produce a live snapshot against a *running* run (today the
fold operates on a captured events file); and a distinct `reduceState` module
that folds `agent-event` into `orchestrator-state` (the agents-fold exists, the
orchestrator-state-fold does not).

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

# Context

Collected deterministically by `keryx flow init` at 2026-08-18T16:28:02.256Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-08T20:19:50.211Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Requirements package already exists, adversarially reviewed, and is the source
of truth — no context-collector/brainstorm dispatch needed:

- `docs/requirements/keryx-multi-agent-engine/README.md` — Phase D summary.
- `docs/requirements/keryx-multi-agent-engine/prd.md` — FR11/FR12, SC7/SC8,
  R8/R9 (Phase D addendum).
- `docs/requirements/keryx-multi-agent-engine/specification.md` §Phase D —
  `executeWaves`/`WaveExecutorDeps` signatures, `SubagentCompletionStatus`
  type, integration points, AC9-AC12.
- `docs/requirements/keryx-multi-agent-engine/implementation-plan.md` Phase D —
  D1a-D2b file-level breakdown (this flow's tasks map directly onto it).
- `docs/requirements/keryx-multi-agent-engine/agent-protocol.md` — Concurrency
  and Result handling sections, now annotated with exactly what Phase D
  changes (post docpack-review fix).
- `docs/requirements/keryx-multi-agent-engine/brainstorm.md` — full
  reference-study evidence (grok-build/codex/opencode), including the honest
  hedge on opencode's default dispatch path (Vercel AI SDK, not directly
  inspected).

### Files this flow will touch

Modified (existing, implemented A→B→C code — sensitive core harness path):
- `src/harness/parallel/scheduler.ts` — add `executeWaves` next to `planWaves`
  (D1a). `planWaves` itself is NOT modified, only added-to.
- `src/commands/agent.ts` — scoped `spawn_subagent`-only concurrent branch in
  the tool-call loop (D1b); `finishReason` threaded out of `runAgentTurn`'s
  return value (D2a). The rest of the loop/turn logic is untouched.
- `src/harness/tool/builtin/spawn-subagent-tool.ts` — consume `finishReason`
  to pick `SubagentCompletionStatus` on the success path; label the existing
  timeout/error/denial branches with their status (D2b). No new detection
  logic — only using what `agent.ts` already computes.

New config surface (additive, optional, backward-compatible):
- `HarnessRunConfig.subagents.maxConcurrency` (D1c).

Tests (extend existing files, per implementation-plan.md):
- `src/harness/parallel/scheduler.test.ts` (AC9, AC10 — fake/injected clocks,
  no real sleep).
- `src/harness/tool/builtin/spawn-subagent-tool.test.ts` (AC11 — one test per
  status value, especially the two net-new: `BudgetExhausted`, `NoProgress`).
- `src/commands/agent.test.ts` (AC12 — regression: no `status`-reading caller
  behaves identically to pre-Phase-D).

### Explicitly NOT touched (PRD Non-Goals)

Model resolution, budget/policy inheritance, D-02, non-`spawn_subagent` tool
dispatch order, the `DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|FAILED`
child-self-reported STATUS-token protocol, any mechanical auto-retry logic.

### Risk note carried from PRD R8

The interactive turn loop, `RemainingBudgetLedger`, and any shared TUI fleet
state were all written assuming one child executes at a time. The ledger's
grant/decrement step MUST stay synchronous/atomic per reservation (no `await`
between check and decrement) so concurrent grants cannot race past the shared
remaining budget — verify this explicitly during implementation, do not assume
it holds just because the ledger's existing sequential tests pass.

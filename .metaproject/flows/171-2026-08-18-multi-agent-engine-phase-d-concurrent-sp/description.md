# Multi-Agent Engine Phase D: concurrent spawn_subagent waves + structured completion status

Status: frozen at flow start
Source: `docs/requirements/keryx-multi-agent-engine/` (README.md, prd.md,
specification.md §Phase D, implementation-plan.md Phase D, agent-protocol.md,
brainstorm.md's Phase D reference study) — extends the already-implemented
A→B→C multi-agent engine (flows 088-101), version 0.3.0, adversarially reviewed
via docpack-review before this flow was opened.

## Problem

Two gaps confirmed by direct code investigation, reported by the operator from
live use across multiple projects (keryx, carlson-bot, goodai):

1. **No real concurrency on the interactive path.** `planWaves`
   (`src/harness/parallel/scheduler.ts`) already computes bounded-concurrency,
   dependency-ordered wave plans and is unit-tested, but nothing executes a
   plan. `src/commands/agent.ts`'s tool-call loop (~line 1192-1238) processes
   every `spawn_subagent` call in a batch strictly one at a time — every batch
   is one wave of size one in practice, regardless of what `planWaves` could
   compute. A three-project reference study (xAI Grok Build, OpenAI Codex CLI,
   sst/opencode — cloned to `~/forks/`, direct code inspection except
   opencode's default dispatch path which delegates to the un-inspected Vercel
   AI SDK) found Keryx is the only one of the four studied that never runs
   sibling spawns concurrently.
2. **A child's own budget exhaustion is invisible to the parent.**
   `spawn-subagent-tool.ts` only sets `isError:true` for a parent-granted
   wall-clock timeout (~line 812-840) or a thrown/internal error (~line
   873-888). When a child exhausts its OWN internal step/tool-call budget
   (`agent.ts`'s `finishWithBudgetSummary`, ~line 1349) or hits the existing
   no-progress detector (~line 1318) without a clean finish, the tool takes
   its normal success path (~line 844-872), returning `isError:false` —
   indistinguishable from a deliberate, successful completion. 2 of 3
   references studied (Grok Build, Codex) distinguish this with a typed
   status; opencode shares Keryx's exact gap for this one specific case.

## Expected Outcome

- **D1 (concurrency):** a new `executeWaves(tasks, waves, deps)` function next
  to `planWaves` in `scheduler.ts` that actually runs a wave plan — waves in
  order, tasks WITHIN one wave concurrently via `Promise.all`, bounded by the
  wave's own size. `agent.ts`'s tool-call loop gains a scoped branch: when a
  turn's batch contains 2+ `spawn_subagent` calls, build `ChildTask[]` (no
  `dependsOn` between same-turn siblings), plan via `planWaves` with a new
  `HarnessRunConfig.subagents.maxConcurrency` field (conservative default, not
  hardcoded), execute via `executeWaves`, splice results back in the model's
  original call order. Every other tool type in the same batch is unaffected —
  this is an additive branch, not a rewrite of the loop.
- **D2 (structured status):** a new `SubagentCompletionStatus` type
  (`"Completed" | "BudgetExhausted" | "Timeout" | "Denied" | "Error" |
  "NoProgress"`) added to the `spawn_subagent` tool's result shape,
  backward-compatible (`isError` stays derived and present). The child turn's
  internal finish reason (`"budget"` from `finishWithBudgetSummary`,
  `"no-progress"` from the existing detector — both already computed, neither
  currently surfaced) is threaded out of `runAgentTurn`'s return value and
  consumed by `spawn-subagent-tool.ts` to pick the right status. Existing
  timeout/error/denial paths gain their own status labels on already-correct
  branches — no new detection logic there, just labeling.

## Out of Scope (per PRD Non-Goals / docpack Phase D framing)

- No change to model resolution, budget/policy inheritance, the D-02 invariant,
  or any contract from the already-shipped A→B→C engine.
- No change to non-`spawn_subagent` tool types' dispatch order in the same
  batch — sequential semantics there are untouched.
- No mechanical auto-retry driven by the new status values — they are
  advisory signals for the orchestrator MODEL's own judgment (retry/extend/
  accept-partial/give up), not a new harness-driven behavior (PRD R9).
- No change to the `DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|FAILED`
  child-self-reported STATUS-token protocol (`subagent-status-protocol.md`) —
  that is a separate axis from the tool-level `status` this flow adds.

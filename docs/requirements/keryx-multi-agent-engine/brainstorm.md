# Multi-Agent Engine — Brainstorm & Decision History
Version: 0.1.0

## Reference designs studied (open source)

| Project | Model resolution | Isolation / spawn | Notable |
|---|---|---|---|
| **opencode** (sst) | `agent.model` → **inherit parent** → provider default; parent `variant` carried only when model not overridden | child = new *session* with `parentID`, same process; one generic `task` tool | `subagent_depth`=1 default; children auto-denied `task`/`todowrite`; result as `<task id state>` XML; background re-injected as synthetic parent msg |
| **grok-cli** (superagent-ai) | vision/computer/explore pinned to constants; custom = own `model`; **general = inherit `this.modelId`** | foreground inline (same process); background = detached OS process (`spawn`,`unref`) | two tools `task`(sync)+`delegate`(async, explore-only); nested bg disabled; inbox/outbox via files; pull-based status |
| **oh-my-claudecode** | env (`ANTHROPIC_MODEL`) → OMC tiers (`OMC_MODEL_HIGH/MEDIUM/LOW`) → **`undefined`=inherit CC default**; keyword routing escalates tier | tmux pane per worker (external process), ephemeral | HUD, snapshot-diff delta events, char-proxy usage (no tokens from codex/gemini), verdict.json (`approve/revise/reject`) |
| **Claude Code / Agent SDK** | env `CLAUDE_CODE_SUBAGENT_MODEL` → per-invocation → frontmatter → **`inherit` default** | fresh isolated context window; opt. git-worktree | `.claude/agents/*.md`; depth ≤5, ≤200/session; background-first; output-scanning vs injection; final message = tool result |

**Convergent pattern (all four):** one generic spawn tool; model = a priority
chain whose terminal fallback is **inherit parent**; single input (prompt) /
single output (final result); explicit sync-vs-async; depth + count caps; tool
scoping where *denies* inherit but *allows* do not.

## Keryx starting point

Keryx is already stronger than most on isolation: fail-closed `inheritBudget` /
`inheritPolicy`, a wave scheduler with cycle detection, canonical
dispatch/result/event/state contracts, and a provenance taint-chain. The single
gap is that **model/provider is neither inherited nor selectable per child**, and
`makeProvider` ignores `_model` and fails open to `FakeProvider`.

## Options generated

### Option A — "Fourth resolver" (Pragmatist)
`resolveChildModel` next to `inheritBudget`; one optional `modelSelection`
contract field; agent definition = optional `model` block on `subagent-dispatch`.
Reuse `planWaves`, `makeProvider`, evidence path unchanged. **Effort: S.**
*Gap:* a low-trust child could still pick a network provider; no cost dimension;
no auto-fallback.

### Option B — A + policy-gated model (Pragmatist)
A plus gating provider class by the child's resolved `PolicyProfile`
(`trustMode`/`network`) via a small `PROVIDER_CLASS` map. Closes A's fail-open.
**Effort: S–M.** Recommended core.

### Option C — Capability-gated lattice + adaptive escalation + event-sourced fleet (Innovator)
- **C1** model as a 4th fail-closed lattice, gated on `ProviderCapabilities`
  (deny if a tool-using dispatch targets a `toolCalls:false` model). **S–M.**
- **C2** cost-aware **adaptive escalation**: a dispatch declares a model *ladder*;
  run cheapest rung, escalate on `NEEDS_CONTEXT/BLOCKED/FAILED`/`not_met`
  acceptance; each rung = new `attempt.number` on the same `branchId`; budget
  lattice self-truncates the ladder. Emits `tier_escalated` decision events. **M.**
- **C3** event-sourced fleet: `orchestrator-state` becomes a pure fold over the
  `agent-event` stream (crash-safe resume + live HUD + deterministic replay);
  git-worktree isolation for parallel *mutating* agents; bounded **peer
  messaging** as an event projection (artifact-refs only, policy-gated). **L.**

## Critical questions (Critic) and how the design answers them

1. **Model as containment-checked policy dimension?** → FR3/G1–G3 provider
   allowlist + trust/network gate (spec §Model Resolution).
2. **Fail-closed vs `makeProvider` fail-open to Fake?** → deny at resolution;
   distinguish *denied* from *degraded* (PRD R2, AC2).
3. **model→cost/tier map honesty across 8+ providers?** → defer cost enforcement;
   document extension point; budget stays runtime+tool-calls (PRD R3, decision D4).
4. **Depth/count/recursion caps?** → `maxTreeDepth` from taint-chain +
   `maxChildrenPerRun` (FR6, AC3).
5. **Budget aggregation authority?** → single run-scoped ledger across waves +
   ad-hoc spawns (FR7, AC3).
6. **Deterministic monitoring?** → pure accounting fold + separate display
   (FR8/NFR2, AC4).
7. **Injection via child output?** → quarantine/re-scan before re-dispatch
   (FR9, AC6).
8. **Credential isolation across providers?** → credentials in the policy grant,
   not ambient `process.env` (FR4, spec §Data Contracts.3).

## Resolved decision forks (user)

- **D1 Scope:** document the **full A → B → C** architecture; implement B + caps
  first, C as roadmap with extension points.
- **D2 Model security:** **policy-gated allowlist** — allowlisted providers only,
  network gated by trust, unknown/uncredentialed denied, creds in the grant.
- **D3 Agent-definition format:** **optional `model` block on the existing
  `subagent-dispatch` contract** — no new `.md` loader.
- **D4 Cost/token budget:** **deferred** — documented as a `maxCostUnits`
  extension point + shared ledger; enforcement stays runtime + tool-calls now.

## Comparison matrix

| Criterion | A | B (core) | C (roadmap) |
|---|---|---|---|
| Effort | S | S–M | S→M→L |
| Closes model fail-open | partial | ✓ | ✓✓ |
| Cost/tier control | ✗ | ✗ | ✓ (C2) |
| Depth/tree caps | ✗ (add) | ✓ | ✓ (C3 fold) |
| Deterministic monitor | n/a | fold | ✓ event-fold |
| Risk | Low | Low | Med→High |

## Recommendation

Implement **B + caps + shared ledger + quarantine** as the first slice on
contracts shaped for C, so escalation, event-sourcing, worktrees, and peer
messaging attach later without contract rework. Defer cost enforcement.

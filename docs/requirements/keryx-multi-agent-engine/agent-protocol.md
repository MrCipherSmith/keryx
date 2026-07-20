# Multi-Agent Engine — Agent Protocol
Version: 0.1.0

Defines how a parent orchestrator and its subagents behave. Complements the
existing `.metaproject/rules/core/subagent-status-protocol.md` and
`subagent-context-construction.md`; this document adds the **model, caps,
monitoring, and quarantine** behavior.

## Roles

- **Parent / orchestrator** — owns spawn, model resolution, caps, the budget
  ledger, monitoring fold, result folding, and completion. Never delegates
  completion (D-02).
- **Child / subagent** — receives one frozen dispatch, does bounded work, returns
  one canonical `subagent-result`. Owns no flow state. May itself spawn only if
  `allowed_actions` includes `spawn-subagent` **and** the caps permit it.

## Lifecycle (per child)

```text
plan dispatch
  -> resolveChildModel   (env -> explicit -> tier -> inherit; gates G1-G3)
  -> inheritBudget       (subset of ledger remaining)
  -> inheritPolicy       (no escalation on trust/capability/isolation)
  -> depth/count caps    (taint-chain length < maxTreeDepth; count < max)
  -> spawnChild          (ANY denial => no partial extension; fail-closed)
  -> run child           (NormalizedRequest from extension.modelSelection)
  -> parseChildResult    (STATUS-first prose -> canonical object)
  -> quarantine scan     (flag instruction-shaped free-text)
  -> childResultToEvidence (fold; disposition -> artifact.kind)
  -> parent advances flow from evidence
```

Guard ordering is fixed: **budget → policy → model → caps**. A later stage never
re-opens an earlier denial. The same input twice yields deep-equal output.

## Model resolution behavior

- **Default is inherit.** An omitted `model` block means the child runs on the
  parent orchestrator's exact `providerId`/`modelId`. This is the common case and
  matches opencode / Claude Code semantics.
- **Explicit** `{ provider, model }` selects laterally — a different provider or
  model is not an escalation, but it MUST pass:
  - **G1** provider ∈ parent allowlist (credentialed),
  - **G2** if network-class provider, child policy permits network,
  - **G3** provider is classifiable (not `unknown`).
- **Tier** `{ tier }` resolves through the deterministic tier map; unknown tier =
  denial.
- **Env override** `KERYX_SUBAGENT_MODEL` wins over all; literal `inherit` = unset.
- **Denied, not degraded.** A failing gate returns `{ok:false, reason}` and the
  spawn is refused. The harness never substitutes `FakeProvider` for an
  orchestrated child (that fallback is for the interactive shell only).
- Emits an `agent-event` `model_resolved { dispatch_id, provider, model, source }`
  for audit.

## Caps & recursion

- **Depth:** `provenance.taintIds.length` is the depth counter; a child at depth
  ≥ `maxTreeDepth` is not granted `spawn-subagent` effect and any deeper spawn is
  denied.
- **Count:** the run-scoped ledger holds a live/emitted child counter; spawn #N+1
  at the cap is denied.
- **Budget:** one `RemainingBudgetLedger` is decremented by every granted
  reservation (wave-scheduled and ad-hoc). `inheritBudget` still checks the
  subset; the ledger owns aggregation so two independent spawns cannot both see
  full parent-remaining.
- All three caps are fail-closed: on breach, refuse rather than clamp.

## Concurrency

- `planWaves` groups children into dependency-ordered, `maxConcurrency`-capped
  waves; the budget fold runs against the shared ledger.
- Cancellation: a `cancelled` task and its transitive dependents are excluded from
  all waves; a running child is cancelled via `NormalizedRequest.signal`
  (`AbortSignal`).
- Sync vs async: foreground children are awaited; background children (roadmap C)
  return immediately and re-inject a completion notification into the parent — the
  parent is told not to poll.

## Result handling

- Child replies STATUS-first (`STATUS: <TOKEN>` + prose) or a canonical object;
  `parseChildResult` normalizes to the canonical `subagent-result`
  (`DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED | FAILED`).
- The disposition survives onto the parent `EvidenceRecord`
  (`artifact.kind = child-result:${status}`); `NEEDS_CONTEXT` names the missing
  bounded artifact.
- **Quarantine:** before the orchestrator plans a next dispatch from a child
  summary, scan the free-text for instruction-shaped patterns (control-tag
  imitations, `Human:`/`Assistant:` turn markers, permission-config mentions).
  Neutralize/flag with a prepended marker line; never execute. Child free-text is
  `trustLevel:"derived"` and stays quarantined from becoming instructions.
- Reviewer roles MAY additionally emit a structured verdict
  (`approve | revise | reject`) as an artifact, mirroring the pattern from
  oh-my-claudecode; this rides on `subagent-result.findings`, not a side channel.

## Monitoring behavior

- Two layers (see specification §Data Contracts.4):
  - **Accounting fold** (pure, replayable): `reduceAgents(events)` → per-child
    `{ status, model, source, budgetRemaining, usage }`. Usage sums only
    provider-reported *exact* tokens; inexact/unknown is marked, never summed as
    exact.
  - **Display** (impure): TUI tree / `keryx agents` table over arrival-ordered
    deltas; never feeds the fold or the state hash.
- Delta events (`spawned/running/idle/done/failed/denied`) are derived by diffing
  successive folded snapshots, not by racing raw provider streams.

## Roadmap behaviors (C — documented, not yet built)

- **Adaptive escalation (C2):** a model ladder; escalate on adverse disposition
  or `not_met` acceptance; each rung a new attempt on the same branch; emits
  `tier_escalated`. Budget lattice self-truncates the ladder.
- **Event-sourced fleet (C3):** `orchestrator-state` as a fold over
  `agent-event`; git-worktree isolation for parallel mutators; bounded
  `peer_message` (artifact-refs only, policy-gated) as an event projection.

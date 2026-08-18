# Multi-Agent Engine — Specification
Version: 0.4.0

> **Status note:** **implemented** as flows 088–101 (Phase A–C) and flow 171
> (Phase D); see `README.md` for the runtime evidence. The original CLI surface
> `keryx agents --json` sketched in this document shipped as `keryx agents
> monitor <events-file> [--json]` (an offline fold over a captured events file);
> the prose below is retained as the design record. **Phase D (§ below) is now
> implemented** (flow 171, tasks T5–T7).

## Module Identity

- **Name:** keryx-multi-agent-engine
- **Kind:** harness capability (subagent orchestration) over the Project Agent
  Harness.
- **Home code:** `src/harness/child/`, `src/harness/parallel/`,
  `src/harness/run/`, `src/harness/provider/`, plus a new monitoring surface.
- **Owner invariant:** the PARENT owns spawn, model resolution, caps, budget
  ledger, completion, and evidence folding. A child owns none of these (D-02).

## Storage / State Structure

No new durable store. Subagent state lives on structures the harness already
persists:

- **Dispatch + resolved selection** — the canonical `subagent-dispatch` object
  plus the harness `ChildContractExtension` (extended with `modelSelection`),
  appended into the parent's own append-only session (isolation by
  `attemptId`/`branchId`, not a separate child store).
- **Provenance** — child `Provenance` is `trustLevel:"derived"` and carries the
  parent's id in `taintIds`; the taint-chain **length is the depth signal**.
- **Result** — canonical `subagent-result` → `EvidenceRecord`
  (`artifact.kind = child-result:${status}`).
- **Orchestrator state** — `orchestrator-state` snapshot today; a pure fold over
  the `agent-event` stream in the roadmap (C).

## Manifest / Config Shape

Harness config (`HarnessRunConfig`) gains, all optional and backward-compatible:

```jsonc
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-4-8",
  "subagents": {
    "maxTreeDepth": 3,          // fail-closed cap on taint-chain length
    "maxChildrenPerRun": 64,    // fail-closed total-child cap
    "providerAllowlist": ["anthropic", "ollama"],  // derived from detectProviders
    "tiers": {                  // deterministic tier -> (provider, model) map
      "cheap":    { "provider": "ollama",    "model": "qwen2.5-coder" },
      "standard": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
      "deep":     { "provider": "anthropic", "model": "claude-opus-4-8" }
    }
  }
}
```

Environment override (highest priority, Claude-Code-style):
`KERYX_SUBAGENT_MODEL="<provider>/<model>"`; the literal `inherit` is equivalent
to unset. Credentials are **not** read here; they are passed as a scoped grant
(see Data Contracts → credential scoping).

## Model Resolution Semantics (core)

`resolveChildModel` is a pure resolver in `src/harness/child/model.ts` (or
alongside its siblings in `isolation.ts`), matching the `inheritBudget` result
idiom. **Unlike budget/policy this is not a subset/containment check** — a
sibling provider/model is a lateral choice — but provider *authorization* IS
fail-closed.

```ts
export interface ModelSelection { providerId: string; modelId: string; }
export interface ParentModelContext { providerId: string; modelId: string; }

export type ChildModelRequest =
  | { kind: "inherit" }
  | { kind: "explicit"; providerId: string; modelId: string }
  | { kind: "tier"; tier: string };

export interface ResolveChildModelDeps {
  allowedProviders: ReadonlySet<string>;   // parent allowlist (credentialed only)
  tiers?: Record<string, ModelSelection>;  // deterministic tier map
  envOverride?: ModelSelection;            // KERYX_SUBAGENT_MODEL, parsed
  policy: PolicyProfile;                    // child's resolved policy
  providerClass: (id: string) => "local" | "network" | "unknown";
}

export type ResolveChildModelResult =
  | { ok: true; selection: ModelSelection; source: "env" | "explicit" | "tier" | "inherited" }
  | { ok: false; reason: string };

export function resolveChildModel(
  parent: ParentModelContext,
  request: ChildModelRequest | undefined,
  deps: ResolveChildModelDeps,
): ResolveChildModelResult;
```

**Resolution order** (first match wins):

1. `deps.envOverride` (if set and not `inherit`).
2. `request.kind === "explicit"` → that provider/model.
3. `request.kind === "tier"` → `deps.tiers[tier]` (deny if tier unknown).
4. `request` omitted or `kind === "inherit"` → `parent` verbatim
   (`source:"inherited"`).

**Fail-closed gates** applied to the candidate before returning `ok:true`:

- **G1 Allowlist:** `deps.allowedProviders.has(candidate.providerId)` — else deny.
- **G2 Trust/network:** if `providerClass(candidate.providerId) === "network"`
  and the child policy forbids network (`trustMode` too low or
  `defaults.network !== "allow"`), deny. `local`/loopback providers are allowed
  for read-only/isolated children.
- **G3 Unknown:** `providerClass === "unknown"` → deny (never construct a
  provider the harness cannot classify).

An inherited candidate is still run through G1–G3; if the parent's own provider
is somehow not allowlisted for the child's trust posture, that is a denial, not a
silent pass — this keeps the taint monotonic.

## Data Contracts

### 1. Dispatch model block (agent-definition surface)

Optional `model` block added to `subagent-dispatch.schema.json` (next to
`budget`), plus the resolved `modelSelection` field on the harness
`ChildContractExtension`. Full JSON Schema:
[schemas/child-model-selection.schema.json](schemas/child-model-selection.schema.json).

Backward compatibility: `model` omitted ⇒ `{ kind: "inherit" }`.

### 2. Safety caps

- **Depth:** `taintIds.length` at spawn time must be `< maxTreeDepth`, else
  `spawnChild` returns `{ ok:false, reason:"depth cap ..." }`.
- **Count:** a run-scoped counter (owned by the single ledger) rejects spawn #N+1
  when N = `maxChildrenPerRun`.
- **Budget ledger:** one mutable `RemainingBudgetLedger` decremented by every
  granted reservation — from `planWaves` *and* every ad-hoc `spawnChild` — so
  aggregate spend across the whole tree is bounded, not per-call. `inheritBudget`
  itself is unchanged (still subset-only); the ledger owns aggregation.

### 3. Credential scoping

`makeProvider` stops reading ambient `process.env` for child construction.
Instead a `CredentialGrant` (a redacted, per-provider map the parent already
holds) is passed in; a child receives only the keys its policy grants. A request
for a provider not in the grant is a denial at resolution (G1), so provider
selection cannot become a credential-presence oracle.

### 4. Monitoring events

New `agent-event` types (`model_resolved`, `tier_escalated`, `peer_message`) —
[schemas/agent-event-extensions.schema.json](schemas/agent-event-extensions.schema.json).
The monitor is two layers:

- **Accounting fold** (pure): `reduceAgents(events) → AgentsSnapshot` — per-child
  `{ dispatchId, status, model, source, budgetRemaining, usage }`. Deterministic,
  replayable, no clock/RNG. Usage counts only provider-reported *exact* values;
  estimated/unknown usage is marked, never summed as if exact.
- **Display** (impure allowed): TUI tree / CLI table rendering arrival-ordered
  deltas. Never feeds back into the fold or the state hash.

### 5. Result folding + quarantine

`parseChildResult` → canonical result → `childResultToEvidence` as today. Added:
before the orchestrator plans a next dispatch from a child summary, the summary is
scanned for instruction-shaped patterns (control-tag imitations, `Human:`/
`Assistant:` markers, permission-config mentions). Matches are neutralized/flagged
(marker line prepended), **never silently executed**. Child free-text stays
`trustLevel:"derived"` and is quarantined from becoming orchestrator instructions.

## Phase D — Concurrent Waves + Structured Completion Status

**Status: implemented (added 2026-08-18, shipped flow 171).** Additive
to everything above — no change to model resolution, budget/policy
inheritance, contracts, or D-02.

### D1. Wave executor (closes the plan/execute gap)

`planWaves` (`src/harness/parallel/scheduler.ts`) already produces a
`Wave[]` — this spec adds the missing executor that actually runs one:

```ts
export interface WaveExecutorDeps<TTask, TResult> {
  /** Runs one task to completion. Must not throw for an ordinary child
   *  failure — failures are values (see D2), not exceptions, so a wave never
   *  aborts its siblings because one child errored. */
  run: (task: TTask, reservation: BudgetReservation) => Promise<TResult>;
}

/** Execute a `planWaves` plan: waves run strictly in order (later waves may
 *  depend on earlier ones per `ChildTask.dependsOn`); tasks WITHIN one wave
 *  run concurrently via `Promise.all`, bounded by the wave's own size (already
 *  ≤ `maxConcurrency` by construction — the executor adds no separate cap). */
export async function executeWaves<TTask extends { taskId: string }, TResult>(
  tasks: readonly TTask[],
  waves: readonly Wave[],
  deps: WaveExecutorDeps<TTask, TResult>,
): Promise<Map<string, TResult>>;
```

Integration point: `src/commands/agent.ts`'s tool-call loop (~line 1192-1238).
When a model turn's `calls` contains 2+ `spawn_subagent` invocations, build
`ChildTask[]` from them (no `dependsOn` between sibling same-turn spawns —
they are independent by construction, since a model cannot see one child's
result before issuing the next call in the same response), call `planWaves`
with `AgentDeps.maxSubagentConcurrency` (implemented as an optional field on
`AgentDeps` with default 3, not config-file-loaded — same deferred state as
existing `maxTreeDepth`/`maxChildrenPerRun`), then `executeWaves` instead of
the current serial `for` loop for that sub-batch specifically. Tool calls of
non-`spawn_subagent` types in the same batch keep the existing sequential path
— this is a scoped, additive branch, not a rewrite of the whole loop.

**`maxSubagentConcurrency` default:** implemented as `DEFAULT_MAX_SUBAGENT_
CONCURRENCY = 3` (not grok-build's 32 — reasoning: cannot assume uniform
provider rate-limit headroom). No env/config-file wiring yet; the field lives
on `AgentDeps` as an injected constant, matching the pattern of existing
`maxTreeDepth`/`maxChildrenPerRun`.

### D2. Structured completion status

```ts
export type SubagentCompletionStatus =
  | "Completed"       // clean finish, model produced a final result
  | "BudgetExhausted"  // child's OWN maxToolCalls/step budget ran out, no clean finish
  | "Timeout"           // parent-granted wall-clock maxRuntimeMs elapsed (existing path)
  | "Denied"            // MAE admission denial (existing path, e.g. depth/count cap)
  | "Error"             // thrown/internal error (existing path)
  | "NoProgress";       // agent.ts's existing no-progress detector fired, distinct from budget exhaustion

export interface StructuredSubagentResult {
  status: SubagentCompletionStatus;
  output: string;               // unchanged shape: bounded summary text
  isError: boolean;              // derived from status (false only for "Completed"), kept for backward compat
  partial?: string;               // best-effort partial output, when status !== "Completed"
}
```

Backward compatibility: existing callers reading only `{output, isError}` see
no change — `isError` is still `true` for every non-`Completed` status, so a
caller that never looks at `status` behaves exactly as today. `status` is
purely additive.

Wiring: `spawn-subagent-tool.ts`'s internal-budget path currently takes the
same branch as a clean finish (~line 844-872, `isError:false`). This spec
requires that branch to first check whether `agent.ts`'s turn result carries a
`finishReason` of `"budget"` (from `finishWithBudgetSummary`, ~line 1349) or
`"no-progress"` (from the existing no-progress detector, ~line 1318) — both
already computed internally, neither currently threaded out of `runAgentTurn`'s
return value to its caller. Threading that reason out is the only new plumbing
D2 requires; no new detection logic.

### D Acceptance Criteria

- **AC9:** N sibling `spawn_subagent` calls in one turn, each backed by an
  injected fake child with a distinct artificial delay, complete in wall-clock
  time bounded by `max(delays)` (property/integration test with fake timers or
  injected clocks — deterministic, no real sleep).
- **AC10:** Concurrent grants against the shared `RemainingBudgetLedger` never
  exceed the parent's remaining budget — extend AC3's existing property test
  to interleaved/concurrent grant calls, not just sequential ones.
- **AC11:** A child whose own step/tool-call budget exhausts before a clean
  finish returns `status: "BudgetExhausted"`; a child hitting the existing
  no-progress detector returns `status: "NoProgress"`; neither is
  `"Completed"`. Existing `Timeout`/`Denied`/`Error` paths are unchanged and
  covered by regression tests (no silent status drift on the paths that
  already worked).
- **AC12:** A dispatch/response shape with no caller reading `status` behaves
  identically to pre-Phase-D Keryx (regression test mirroring AC7's pattern).

## CLI / Skill Surface

- `keryx agents` — interactive multi-subagent view (tree, per-child status,
  resolved model + source, ↑in/↓out tokens, budget remaining).
- `keryx agents --json` — headless snapshot from the accounting fold (states:
  `spawned | running | idle | done | failed | denied`).
- Orchestrator-facing: `spawnChild` (extended inputs), `planWaves` (unchanged
  budget fold; `ChildTask` gains optional `modelRequest`), the canonical
  dispatch/result contracts. The user never types internal names — natural
  intent routes through `.metaproject/index.md`.

## Integration Points

- **Provider port** (`src/harness/provider/`): `makeProvider` becomes
  model-aware and credential-scoped; `NormalizedRequest.{providerId,modelId}` is
  fed from `extension.modelSelection`.
- **Scheduler** (`parallel/scheduler.ts`): `ChildTask.modelRequest?`; budget fold
  unchanged; the run-scoped ledger wraps both scheduler and ad-hoc spawns.
- **Contracts** (`.metaproject/core/gdskills/contracts/`): `subagent-dispatch`
  gains `model`; `agent-event` gains the three types; `harness-child-contract-
  extension` gains `modelSelection`.
- **Observability** (`keryx-execution-observability`): usage/retry taxonomy,
  per-run evidence reused by the fold.
- **Task Manager / flow**: orchestrators dispatch subagents; D-02 unchanged.
- **Interactive turn loop** (`src/commands/agent.ts`, Phase D): the tool-call
  execution loop gains a scoped concurrent-`spawn_subagent` branch using
  `executeWaves` (D1); every other tool type's dispatch order is unchanged.

## Acceptance Criteria

- **AC1:** `resolveChildModel` returns `inherited` for an omitted request and the
  parent selection; `explicit`/`tier` for those, gated by G1–G3. Pure + unit
  tested (deterministic).
- **AC2:** Unknown/uncredentialed/unauthorized provider ⇒ `{ok:false}`; no
  `FakeProvider` no-op child run occurs on the orchestrated path.
- **AC3:** `spawnChild` denies on depth ≥ `maxTreeDepth` and on count >
  `maxChildrenPerRun`; the shared ledger prevents aggregate over-grant across
  waves + ad-hoc spawns (property test).
- **AC4:** `reduceAgents` is pure — identical event logs yield deep-equal
  snapshots and stable hashes; `keryx agents --json` matches the fold.
- **AC5:** Model selection composes with `inheritBudget`/`inheritPolicy`: order
  is budget → policy → model; any denial refuses the whole spawn (no partial
  extension), matching existing fail-closed behavior.
- **AC6:** Instruction-shaped child summaries are flagged before re-dispatch.
- **AC7:** A dispatch with no `model` block is byte-for-byte behavior-compatible
  with the pre-engine path (regression test).
- **AC8:** Zero-`dependencies` guard and determinism tests pass; any optional dep
  has an ADR + AC15 pin.

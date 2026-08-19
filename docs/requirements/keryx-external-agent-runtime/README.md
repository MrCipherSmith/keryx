# Keryx External Agent Runtime
Version: 0.5.0

## Purpose

Let keryx delegate bounded work to the vendors' own coding CLIs — `codex exec`
and `claude -p` — as **child agents of the existing harness**, so the operator's
own subscription performs the work while keryx keeps ownership of policy,
budget, isolation, monitoring and completion.

The operator's framing, and the constraint this package is built around:

> The external agent does everything; it does it under our policies.

This is not a new provider. It is a second **runtime** behind the child-agent
machinery already shipped by `keryx-multi-agent-engine`: where a keryx child
runs an in-process agent loop, an external child runs a vendor CLI subprocess
and its event stream is folded into the same contracts.

## Status

**implemented (read-only release), never run against a real process.**

Shipped in flow 176: the registry and both codecs, the `runtime` block and its
fail-closed validator, the child environment builder, prompt assembly, process
supervision and the real spawn port, the orchestrating runtime, the opt-in
capability gate with its transport/CI hard disable, `keryx agents external
list|probe`, the `spawn_subagent` seam, and the operator surface — live
transcript, Work/Meta/Command modal, sidebar marker, per-addressee message
queue, and `/delegate`.

Three things that status does **not** mean, stated here because a status line is
exactly where a reader stops:

- **No vendor process has ever been spawned by this code.** Every test uses a
  fake spawn port and the recorded transcripts in `fixtures/external/`. Until the
  live smoke test runs, "implemented" means "implemented and offline-verified".
- **Supervision triggers do not exist** (R15 unmet). The parent agent receives an
  external child's result and nothing before it; specification §7.6 is marked
  inline.
- **Mutating external agents were never in scope** for this release. The
  permission axis is in the contract and `worktree-write` is refused at runtime
  with a reason distinct from "this agent cannot".

The feature is off by default and local-only. See
[decisions.md](decisions.md) D-01 for the credential boundary and why no vendor
sanction is claimed.

What already existed and is reused (not claimed as this package's work):

- `src/harness/child/spawn.ts` (`SpawnChildRequest` / `SpawnChildInput` /
  `SpawnChildDeps`), `ledger.ts` (`RemainingBudgetLedger`, including the
  `maxCostUnits` dimension), `quarantine.ts` (`quarantineChildSummary`),
  `worktree.ts` (`needsWorktree`, `WorktreePort`) and its real adapter
  `git-worktree-port.ts` (`git worktree add --detach`).
- `src/harness/tool/builtin/spawn-subagent-tool.ts`, which already carries
  `SubagentMode = "read_only" | "general"`, `SubagentCompletionStatus`
  (`Completed | BudgetExhausted | Timeout | Denied | Error | NoProgress`) and
  `StructuredSubagentResult`.
- `src/harness/monitor/reduce.ts` / `reduce-state.ts` — the pure folds over the
  `agent-event` stream.
- `.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json`, whose
  `model` block (flow 089) and `allowed_actions` enumeration this package
  extends rather than replaces.
- `src/tui/modal-host.ts`, `subagent-inspector.ts`, `subagent-session.ts` and
  the pure queue helpers in `src/tui/main-queue.ts`.
- `src/capability/` — the opt-in capability framework. It was an empty registry
  before this flow; this feature is its **first real descriptor**.

A working precedent for the mechanism itself lives in
`scripts/benchmark/run-ablation-codex.ts`, which already spawns
`codex exec -s read-only --json`, parses its JSONL stream and runs it in an
isolated worktree against an already-authenticated CLI.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Identity, registry and codec structure, contracts, CLI/TUI surface, acceptance criteria. |
| [agent-protocol.md](agent-protocol.md) | External child behaviour: prompt construction, event mapping, supervision, failure classification. |
| [security-policy.md](security-policy.md) | Isolation, environment hygiene, credential boundary, quarantine, transport restrictions. |
| [decisions.md](decisions.md) | Adopted decisions and refusals, including the compliance boundary against `provider-auth` D-01. |
| [brainstorm.md](brainstorm.md) | Decision history: reference designs studied, options, resolved forks, critical questions. |
| [schemas/external-agent-runtime.schema.json](schemas/external-agent-runtime.schema.json) | The `runtime` block added to `subagent-dispatch`. |
| [schemas/external-agent-registry-entry.schema.json](schemas/external-agent-registry-entry.schema.json) | A registry entry: binary, detection, supported modes, known version range. |

## Scope

- A **registry** of external agent CLIs holding metadata only (id, binary,
  detection method, supported sandbox modes, known-good version range, whether
  streaming input is supported).
- A **codec module per CLI** — `codex-cli` and `claude-cli` in this release —
  owning argv construction, event parsing and failure classification, each
  pinned by fixtures of recorded transcripts so the whole adapter is testable
  offline.
- A `runtime` block on `subagent-dispatch`, and its threading through
  `spawnChild` so an external child inherits the existing budget ledger, depth
  caps, worktree isolation, quarantine and `agent-event` stream unchanged.
- **Read-only execution** in a disposable worktree, held by three independent
  mechanisms: the CLI's own sandbox flag, a restricted tool roster
  (`--tools`, an allow-list — verified live in flow 176 T1), and the throwaway
  checkout, which is the load-bearing one.
- A **supervision channel**: a bidirectional message path so the operator can
  steer a running external agent from the TUI using the existing main-queue
  semantics — shipped. The folded, trigger-driven view for the *parent agent* was
  specified in the same breath and is **not implemented** (R15); see the Status
  note above and specification §7.6.
- A **TUI surface**: external children appear in the subagent sidebar and open
  in the shared modal, rendering their work as a live structured transcript.
- An **opt-in capability gate**, off by default, local-only.

## Non-goals

- Any use of a vendor's subscription credential by keryx itself. keryx never
  reads, stores, forwards or proxies a token — see [decisions.md](decisions.md) D-01.
- A `ProviderPort` adapter for these CLIs. They are whole agents, not completion
  endpoints; the rejection is recorded in [decisions.md](decisions.md) D-02.
- Mutating external agents. The permission axis exists in the contract from day
  one, but only `read-only` is in scope for this release
  ([decisions.md](decisions.md) D-04).
- Treating an external agent's output as completion evidence
  ([decisions.md](decisions.md) D-05).
- An interactive/PTY or tmux-attached view of the external agent
  ([decisions.md](decisions.md) D-11).
- Any relaxation of the child-agent invariant recorded as D-02 in
  `keryx-project-agent-harness` — a child never writes flow state. (Not to be
  confused with this package's own D-02, which concerns the runtime seam.)
- New runtime dependencies. The zero-`dependencies` policy holds.

## Related modules

- [Keryx Multi-Agent Engine](../keryx-multi-agent-engine/README.md) — the child
  spawn, model resolution, ledger, caps, worktree and monitoring machinery this
  package adds a runtime to.
- [Keryx Project Agent Harness](../keryx-project-agent-harness/README.md) — the
  session, budget, policy and child contract underneath.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — D-01 there is the
  compliance boundary this package sits beside and must not cross.
- [Keryx OpenTUI Modal and Tabs](../keryx-opentui-modal-tabs/README.md) and
  [TUI Main-Queue Dock](../keryx-tui-queue-dock/README.md) — the modal host and
  queue surface the operator interaction builds on.
- [Keryx Execution Observability](../keryx-execution-observability/README.md) —
  provenance and retry taxonomy the monitor reuses.
- [Keryx OS Sandbox](../keryx-os-sandbox/README.md) — the OS-level containment
  keryx applies to its own shell execution; an external CLI brings its own and
  the two must not be assumed equivalent.

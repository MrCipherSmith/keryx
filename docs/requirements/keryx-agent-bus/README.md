# Keryx Agent Bus
Version: 0.6.0

## Purpose

Let several interactive `keryx shell` instances working on one clone (the
checkout and its linked worktrees) **see each other** and **send each other
messages**. For example, one agent asks the others to hold their pushes while it
cuts a release, and tells them when it is done.

It also adds an exclusive **session lease**, so two shells can no longer open
the same session and silently overwrite each other's turns.

## Status

**P0–P3 implemented. P4–P5 specification ready, not implemented.**

- **P0 session lease: implemented** in flow 271, PR
  [#607](https://github.com/MrCipherSmith/keryx/pull/607). Opening a session
  takes an exclusive lease: `-c` skips live sessions, `-r` on a live session
  offers fork, view or cancel, and `keryx sessions list` marks live and stale
  sessions. Two `-c` shells no longer share one session.
- **P1 bus store and CLI: implemented** in flow 272, PR
  [#611](https://github.com/MrCipherSmith/keryx/pull/611). The bus store lives
  under the git common directory: presence records, the append-only event log,
  a read-only session-lease reader, and prune. `keryx bus list|log|send|prune`
  refuses mutating commands inside a tool call (D-13), applies the clone-wide
  CLI rate limit, and reports `bus-disabled` when the bus is off.
- **P2 shell integration: implemented** in flow 273, PR
  [#615](https://github.com/MrCipherSmith/keryx/pull/615). Shells join the bus
  at startup with presence and heartbeat records. A poller detects new peers
  and events. Event lines print to the operator. The `/bus` slash command lists
  peers, sends messages, replies to and asks questions. A Peers sidebar shows
  live shells.
- **P3 agent delivery and tools: implemented** in flow 274, PR
  [#620](https://github.com/MrCipherSmith/keryx/pull/620). Peer messages reach
  the agent as tool-provenance context. An idle agent is woken by a question,
  reply, handoff or name-addressed notice, capped by the auto-wake limit. The
  agent has `bus_list` and `bus_send` tools, with rate limits and a conduct
  block. Ack writes record delivery.
- **P4–P5: not implemented.** Pause leases and wiki/scenario documentation do
  not exist yet.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package status, scope and index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Storage, primitives, data contracts, lifecycle, surfaces, integration points, acceptance criteria. |
| [decisions.md](decisions.md) | D-01 to D-13: the choices the operator made on 2026-09-19, the rules derived from them, and the corrections from the package review. |
| [agent-protocol.md](agent-protocol.md) | How an agent reads, sends and honours pause leases. |
| [artifact-lifecycle.md](artifact-lifecycle.md) | Presence, session lease, pause lease and log lifecycles, plus self-managed retention. |
| [implementation-plan.md](implementation-plan.md) | Phases P0–P5, test strategy, rollback, out of scope. |
| [schemas/bus-event.schema.json](schemas/bus-event.schema.json) | One line of `events.jsonl`. |
| [schemas/bus-presence.schema.json](schemas/bus-presence.schema.json) | One presence record. |
| [schemas/pause-lease.schema.json](schemas/pause-lease.schema.json) | One active pause lease. |
| [schemas/session-lease.schema.json](schemas/session-lease.schema.json) | Session lease owner record. |

## Scope

- Session lease: `-c` skips live sessions, and `-r` on a live session offers
  fork, view or cancel.
- A clone-wide bus in the git common directory, with presence, an append-only
  event log, polling delivery, and the idle-wake and round-boundary injection
  that task notifications already use.
- Typed messages with a bounded text body, addressed to `@name` or `@all`, and
  delivery acknowledgements.
- Pause leases:
  - `turns`, `git-publish` and `advisory` scopes;
  - a TTL, and holder liveness;
  - a new approval-gate floor, so `git-publish` also prompts in `auto` mode;
  - an operator override.
- Surfaces:
  - the agent tools `bus_list`, `bus_send` and `bus_pause`;
  - the TUI command `/bus`;
  - the CLI command `keryx bus`, which refuses mutating commands inside a tool
    call.

## Non-goals

- Transcripts, prompts, hidden reasoning, diffs or file contents on the bus
  (D-01).
- Flow state of any kind: claims, reservations or transitions (D-11,
  ADR-0002). Duplicate-work reservations belong to RP-08.
- A daemon, a socket server, a network listener, or a new runtime dependency.
- Remote transports and `keryx serve` turns.
- MCP and external-agent participation, which is v2 (D-08).
- Letting a peer change another instance's permission mode, plan mode,
  approvals or grants.

## Related modules and packages

- [SAC RP-08 Collaboration and Worktrees](../shared-agent-context-collaboration-worktrees/README.md):
  a separate ledger that stays metadata-only. The relationship is in D-01.
- [Keryx Background Task Execution](../keryx-background-task-execution/README.md):
  the task-notification delivery path the bus mirrors.
- [Keryx External Agent Runtime](../keryx-external-agent-runtime/README.md):
  the per-addressee queue and the rule that nothing is reported as delivered
  unless it was.
- [Keryx Multi-Agent Engine](../keryx-multi-agent-engine/README.md): in-process
  peer messaging and quarantine.
- [Keryx OpenTUI Shell](../keryx-opentui-shell/README.md): the host surface.
- ADR-0002 (`docs/decisions/keryx-harness/ADR-0002-d02-single-coordinator-ownership.md`):
  the single Flow coordinator.

# PRD: Keryx Agent Bus
Version: 0.2.1

## Problem

An operator often runs several `keryx shell` instances against one repository at
once, usually in separate worktrees of one clone: one cuts a release, another
fixes a bug, a third reviews. Today those instances cannot see each other and
cannot talk.

Verified against `main` at d6f864b3:

- **No awareness.** There is no registry of running shells, no pid file, no
  heartbeat, no socket, and no file watch. A running instance exists only as an
  in-memory `liveSession` handle (`src/tui/tui-shell.ts`).
- **No way in from outside.** The only automatic input a running agent accepts
  is a task notification from its own in-process `jobRegistry`
  (`src/commands/agent.ts`, `drainUndelivered`).
- **Silent session loss.**
  - `openSession` (`src/session/store.ts`) takes no lock, and `persistHistory`
    rewrites `context.jsonl`, `archive.jsonl` and `summary.json` in full from
    memory.
  - Two shells started with `-c` attach to the same latest session, and the last
    writer erases the other's turns.
- **No coordination.** Nothing lets one agent say "I am pushing a release tag,
  hold your pushes for ten minutes". The operator has to relay it between
  terminals by hand, or two agents race on `main`.

The existing multi-agent machinery works only **inside** one shell process:

- subagents and peer messaging in `src/harness/child/peer.ts`;
- external children and per-addressee queues in `src/tui/addressee-queue.ts`
  and `src/tui/external-delivery.ts`;
- the worker fleet.

RP-08 (`shared-agent-context-collaboration-worktrees`) plans cross-worktree
metadata such as reservations and handoffs. It deliberately excludes messages
and is not implemented.

## Goal

Every interactive keryx shell in a clone can:

1. **see** the others: who they are, which worktree, branch and session they are
   in, and whether they are idle, working or held;
2. **message** a peer or all peers, from the agent or from the operator, with
   delivery that wakes an idle recipient and never interrupts a model round;
3. **ask peers to pause**, by holding their turns or their publishing commands
   for a bounded time, with an operator override on the receiving side;
4. **never share a session** with another live instance by accident.

## Users

| User | Need |
|---|---|
| Operator running several shells | See all agents in one place; tell one or all to hold; stop relaying by hand. |
| Agent cutting a release | Ask the others not to push while the tag and publish run, and say when done. |
| Agent in another worktree | Learn about a peer's release or a changed plan before acting on stale assumptions; ask a question and receive a reply. |
| Future external agent (Claude Code, Codex) | Join later through MCP without a format change (v2). |

## Requirements

### Functional

| ID | Requirement |
|---|---|
| FR1 | An open session is held by exactly one live instance. `-c` skips held sessions. `-r` on a held session offers fork, view or cancel (D-07). |
| FR2 | Each interactive shell joins a clone-wide bus on start and leaves on exit (D-02). |
| FR3 | Presence shows name, status, activity, checkout, branch and session for every live or stale peer, in the TUI and on the CLI. |
| FR4 | Messages are typed (`notice`, `question`, `reply`, `handoff`, `pause-request`, `resume`) with a text body of at most 2048 bytes (D-01). |
| FR5 | Addresses are `@name` or `@all`. Recipients are resolved to live instances at send time (D-06). |
| FR6 | Messages reach the operator immediately and the agent at a safe point: an idle wake, or the next drain point of a running turn: the round boundary or the post-answer check (D-04). |
| FR7 | Receipt is observable: the sender sees an `ack` when the message entered the recipient's history. |
| FR8 | A pause lease has a scope (`turns`, `git-publish`, `advisory`), a TTL of at most 4 h, and targets, never including its own holder. It ends on resume, expiry, or the holder's death. A stale, hung holder keeps it (D-03, D-09). A `git-publish` lease makes publishing commands prompt even in `auto` mode. |
| FR9 | The targeted operator can override a lease with one command. The override is recorded and visible to the holder. |
| FR10 | Both the agent (`bus_list`, `bus_send`, `bus_pause`) and the operator (`/bus`, `keryx bus`) can send. `bus_pause` passes the permission-mode gate (D-05). The agent cannot reach the CLI's mutating commands through `shell_exec` by accident (D-13). |
| FR12 | Switching sessions inside a running shell respects the lease and never leaves the instance holding none. |
| FR11 | The bus can be disabled per process and persistently, and is off in CI. |

### Non-functional

| ID | Requirement |
|---|---|
| NFR1 | No new runtime dependency, no daemon, no network listener. |
| NFR2 | Peer text is redacted on write and quarantined on read, and it enters history as `provenance: "tool"`, never as operator input (D-10). |
| NFR3 | Storage is bounded without the retention engine: log rotation at 1 MiB, two segments kept, pruning of dead records (see [artifact-lifecycle.md](artifact-lifecycle.md)). |
| NFR4 | The bus never writes Flow state (D-11, ADR-0002). |
| NFR5 | Cost is bounded: automatic wakes share the existing cap, and a broadcast `notice` never wakes an agent (D-12). |
| NFR6 | With the bus disabled, shell behaviour is unchanged. |
| NFR7 | Delivery latency to an idle peer is at most 2 poll intervals (default 3 s). The heartbeat and poll together cost less than 1% of one core while idle. |

## Success criteria

- The two motivating scenarios pass end to end on a real clone with two worktrees:
  1. A pauses B's publishing and resumes it.
  2. A asks B a question and gets a reply.

  Both are recorded as evidence in the implementing flow.
- AC1–AC22 in [specification.md](specification.md) are green.
- No regression in the existing TUI, agent and session suites.
- The session-loss defect (two `-c` shells) is covered by a regression test that
  fails on current `main`.

## Risks

| Risk | Mitigation |
|---|---|
| Prompt injection from a peer | D-10: redaction, quarantine, a wrapper banner, and tool provenance. The bus cannot touch permission state. |
| Agents talking to each other at model cost | D-12: shared wake cap, no wake on broadcast, rate limits. |
| A crashed holder freezing peers | D-03 and D-09: a lease dies with its holder's heartbeat. Operator override is always available. |
| Torn or interleaved appends | Appends under `append.lock` with `seq` from `head.json`, and readers skip unparsable lines (AC15). |
| An agent bypasses its own gated tools through `keryx bus` in `shell_exec` | `shell_exec` is not contained by default (D-02), so D-13 makes the CLI refuse mutating commands inside a tool call, and clone-wide CLI limits apply (D-12). The marker is advisory; the `shell_exec` approval is the hard control. |
| A sleeping laptop ends a release lease | A stale holder keeps its leases, and only a gone holder loses them (D-03, D-09). |
| Pid reuse keeps a dead shell "present" | D-09: the heartbeat is primary, and the pid only separates stale from gone. |
| Overlap with RP-08 | D-01 keeps the two ledgers separate. RP-08's docs are cross-referenced, not rewritten. |
| Held turns surprise the operator | The status bar shows holder, reason and TTL. Queued lines are kept, not dropped. Override takes one command. |

## Recommendation

Build it in the order of [implementation-plan.md](implementation-plan.md). The
session lease comes first because it fixes a live data-loss defect on its own
and supplies the liveness primitive the bus depends on. Then the log and
presence with the CLI, then shell integration, then agent delivery and tools,
and pause leases last. MCP participation is v2 (D-08).

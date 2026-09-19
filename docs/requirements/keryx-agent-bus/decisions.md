# Decisions: Keryx Agent Bus
Version: 0.3.0

## Status

Decision record. D-01 to D-08 were put to the operator on 2026-09-19 as explicit
forks with options and a recommendation, and the operator chose the recommended
option every time. The rejected options are kept because each shows what the
bus deliberately does not do. D-09 to D-13 follow from those answers and from
the code as it stands. They were not asked separately. D-13 and the corrections
to D-02, D-03, D-05 and D-09 came from the adversarial package review.

## D-01: Messages are typed, with a bounded text body

**Question.** RP-08 lists "a shared raw transcript, prompt, hidden-reasoning, or
chat bus" as a non-goal, and its collaboration events refuse free text. Does the
agent bus carry text at all?

**Decision.** Yes, bounded. Every message has a closed `kind`
(`notice | question | reply | handoff | pause-request | resume`, plus
system-written `ack | override | lease-expired`). It may also carry a UTF-8 body
of at most 2048 bytes. The body is redacted at write time and quarantined at
read time.

**Rejected.**

- *Typed events only*: this cannot express "hold off, I am cutting 0.2.117 and
  the tag push takes about five minutes". That is the motivating case.
- *Free chat*: unbounded bodies turn every peer into an injection surface, and
  the bus into a transcript mirror.

**Consequence for RP-08.** RP-08's collaboration ledger stays metadata-only and
is not changed. The bus is a separate coordination channel with its own
contract. RP-08's non-goal still holds for everything the bus does not carry:
transcripts, prompts, hidden reasoning, copied source, and unbounded chat.
RP-08's README and agent protocol gain a cross-reference saying so. Neither
ledger may carry or reference the other's payloads.

## D-02: One bus per clone, stored in the git common directory

**Decision.** The bus lives at `<git-common-dir>/keryx/bus/<project-key>/`. It
has the same scope and key as flow-id allocation (`src/flow/allocation.ts`), so
agents in every linked worktree of one clone see each other. That is where
parallel work in this repository actually happens. Outside git it falls back to
`<dataDir>/bus/<session-project-key>/`.

**Rejected.**

- *One checkout* (`.metaproject/data/bus/`): agents in sibling worktrees would be
  invisible to each other, which defeats the main scenario.
- *User-global*: cross-project messaging is a different feature, and one log
  across projects is harder to bound.

**Accepted cost.**

- **The bus is writable from `shell_exec`.** OS containment of `shell_exec` is
  **off by default**: `resolveShellSandboxMode`
  (`src/harness/process/shell-spawn.ts`) returns `off` unless
  `KERYX_SANDBOX_SHELL` or the sandbox config opts in. So an agent can run
  `keryx bus …` through `shell_exec` unless something stops it. D-13 is what
  stops it.
- Under an opted-in `workspace` or `strict` sandbox, a linked worktree's git
  common directory is outside the writable roots, and `keryx bus` fails there
  with a named error. The shell process itself is never sandboxed and is the
  normal writer.
- The retention engine only walks `.metaproject/`, so the bus bounds its own
  storage ([artifact-lifecycle.md](artifact-lifecycle.md)).

## D-03: Pause is a hybrid, an advisory lease plus a held turn

**Decision.** A `pause-request` creates a **pause lease** with a TTL, targets,
scope and reason. A targeted shell enforces the scope at a small number of
defined points:

- `turns` holds new turns;
- `git-publish` escalates publishing commands to an approval prompt.

The operator of the targeted shell can always override with one command, which
is recorded. A turn already running is never killed. It learns about the lease at
its next drain point (specification §5.3).

**Rejected.**

- *Message only*: the receiving agent may ignore it or never be woken.
- *Hard lock*: a crashed holder would freeze every peer until the TTL runs out,
  with no operator escape.

**Liveness rule.** A lease is active while it is not expired, not resumed, and
its holder is not **gone** (D-09).

- A crashed holder releases its leases within one liveness window, not one TTL.
- A **stale** holder keeps its leases. A stale holder is on the same host with a
  live pid, for example a laptop that slept through a release. It is not dead,
  and ending its lease mid-release is the failure the lease exists to prevent.

**Holder and targets.** A lease never targets its own holder. `@all` is stored
as `["*"]` and read **dynamically**: it means every instance except the holder,
including instances that join while the lease is active. A release pause should
also cover a shell started halfway through the release. Only the holder, or an operator
outside any keryx tool call (D-13), may end a lease for everyone. A target's
operator may release only their own instance, with `override`.

## D-04: Delivery is by polling the log

**Decision.** Each shell polls the tail of `events.jsonl` from an in-memory byte
cursor, by default every 1500 ms. New messages are handled as follows:

- An idle agent is woken through the existing idle-wake path, the same one that
  task notifications use (`tui-shell.ts` `jobRegistry.onCompletion` →
  `runLine("", …)`).
- A busy agent receives the messages at its next drain point: the round
  boundary, or the post-answer check when a turn ends in plain text. These are
  the same sites where `drainUndelivered()` is called for tasks
  (`src/commands/agent.ts`, specification §5.3).

**Rejected.**

- *Unix socket per instance*: needs a server, socket clean-up and a fallback for
  dead peers, and still needs the log for history.
- *`fs.watch`*: behaves differently on macOS and Linux, is used nowhere in the
  codebase today, and still needs polling as a backstop.

## D-05: Both the agent and the operator can send

**Decision.**

- The operator sends through `/bus` in the TUI and `keryx bus` on the CLI.
- The agent has **two tools**, because a tool's risk is static
  (`tool.definition.risk`, read once in `executeCall`, `src/commands/agent.ts`):
  - `bus_send` has risk `read`. It carries `notice`, `question`, `reply` and
    `handoff`, and passes without a prompt.
  - `bus_pause` has risk `write`. It carries `pause-request` and `resume`, and
    goes through `resolveApprovalDecision`
    (`src/commands/permission-mode.ts`):
    - `ask`: prompt;
    - `trust` and `auto`: no prompt;
    - `/plan`: denied.

    The `write` branch of `executeCall` today takes its escalation input from
    `input.patch` (`classifyPatchRisk`). P4 makes that input tool-specific:
    `apply_patch` keeps the patch classifier, and `bus_pause` has no escalation
    dimension.
- Every sender is rate-limited (D-12). The agent cannot route around either tool
  through `shell_exec` (D-13).

**Rejected.**

- *Operator only*: loses "the release agent itself asks the others to pause".
- *Agent unrestricted*: a confused agent could freeze every peer without anyone
  seeing a prompt.

## D-06: Addresses are instance names plus `@all`

**Decision.**

- Each joined instance has a short name, from `--name <name>` or assigned
  automatically as `agent-<n>` with the lowest free `n`.
- Names are unique among **live** instances. If an explicit name is taken by a
  live instance, the new instance joins as `<name>-2` (then `-3`, and so on) and
  says so on startup. It never takes the name over.
- `all`, `cli` and `system` are reserved and are never assigned as names.
- Addresses are `@<name>` or `@all`.
- Recipients are resolved to instance ids **at send time**, and the resolved
  list is written into the event. Sending to a name that is not live fails; it
  is not queued for a future instance.

**Rejected.**

- *Broadcast only*: every agent pays tokens for every conversation.
- *Roles* (`@releasers`): needs a role model. It can be added later as another
  address form without changing the log format.

## D-07: Session lease ships first, as part of this package

**Decision.** Phase 0 adds an exclusive lease on an open session. The rules:

- `keryx shell -c` skips sessions that are leased.
- `-r <id>` on a leased session offers *fork*, *view* (read-only export into the
  transcript) or *cancel* when interactive, and fails with a fork hint when not.
- `keryx sessions list` marks leased sessions as live.

**Why here.** Today two shells on one session silently overwrite each other's
turns. `persistHistory` (`src/session/store.ts`) rewrites whole files from
memory, and `openSession` takes no lock. The lease uses the same mechanism as
presence (a heartbeated directory lock with a pid owner), and the bus needs a
reliable "which session does this instance hold".

## D-08: External agents (MCP) join in v2

**Decision.**

- v1 has two kinds of participant:
  - interactive `keryx shell` instances (TUI and readline) as full members with
    presence and delivery;
  - the `keryx bus` CLI as a stateless sender and reader. Anything that can run
    a command can already post.
- `bus.*` MCP tools come in v2, together with presence and wake for agents that
  do not poll by themselves (Claude Code, Codex).
- The event format already carries `origin`, and `from` is not tied to a shell,
  so v2 needs no format change.

## D-09: Presence liveness is a heartbeat first, the pid second

**Decision.** A presence record is **live** when its `heartbeatAt` is at most
15 s old. The heartbeat is written every 5 s. A record older than that is:

- **stale** when its `host` equals this host and its `pid` is alive (the
  process is hung or its event loop is stalled);
- **gone** otherwise.

Stale instances:

- are listed;
- receive no new messages, and are not resolved as recipients;
- **keep the pause leases they hold** (D-03);
- keep their session lease, which only `--take-over` reclaims.

**Why not the pid alone.** Pids are reused, and `isLockHeld`'s "alive pid wins
over age" rule would keep a crashed shell present whenever an unrelated process
reuses its pid. The heartbeat is the primary signal; the pid only separates
"hung" from "gone".

**This is not `withFileLock`'s rule.** `withFileLock` and `isLockHeld`
(`src/lib/fs.ts`) use the directory mtime plus "a live pid wins", and their
owner record has no `host` or `heartbeatAt`. The session lease and presence use
the D-09 rule. The two share file I/O only; `withFileLock`'s behaviour is
unchanged.

## D-10: Delivered text is peer data, never operator input

**Decision.** A delivered message enters history as `role: "user"` with
`provenance: "tool"`, wrapped in `<peer-message …>` under a banner that says it
comes from another agent and is not an instruction from the user. The same
shape is used for task notifications (`buildTaskNotification`, `agent.ts`). The
body passes `redactSensitiveText` when written and a peer variant of
`quarantineChildSummary` when read. Nothing on the bus can change the
recipient's permission mode, plan mode, approvals or grants.

## D-11: The bus never writes Flow state

**Decision.** `refs.flowId` and `refs.taskId` are informational links only. The
bus does not claim, reserve, transition or complete flows or tasks. ADR-0002
keeps Task Manager as the single coordinator. Duplicate-work reservations belong
to RP-08.

## D-12: Bounds on every sender

**Decision.**

| Limit | Value |
|---|---|
| Body size | 2048 bytes |
| Messages per instance, agent origin | 10 per minute |
| Messages per instance, operator or CLI origin | 30 per minute |
| CLI-origin messages, whole clone | 30 per minute |
| Active pause leases per holder | 1 |
| Active CLI-origin pause leases, whole clone | 1 |
| Pause TTL | default 30 min, maximum 4 h |
| Automatic wakes by bus messages | share the existing `consecutiveAutoWakes` cap |

A broadcast `notice` never wakes an idle agent. It is shown to the operator and
delivered with the next turn.

**Why.** Two agents that answer each other can loop forever at model cost. The
shared wake cap and the no-wake broadcast rule stop that without a separate
loop detector.

The CLI takes a fresh sender id on every call, so a per-instance limit alone
would not bound it. The clone-wide CLI limits are what bound it.

## D-13: The agent cannot use the CLI to bypass its own tools

**Problem.** `shell_exec` is not contained by default (D-02). An agent could
therefore run `keryx bus pause @all …` and skip:

- the D-05 approval gate;
- the per-instance rate limits;
- the holder-liveness rule.

**Decision.** `keryx bus send|pause|resume` refuse with `use-agent-tool` when
they run inside a keryx shell's tool call. `keryx bus list|log` stay available.
The marker is a dedicated `KERYX_TOOL_CALL=1`, set only on `shell_exec`
children.

The caller-session variables (`KERYX_SESSION_*`, `src/lib/caller-session.ts`)
were rejected as the marker. Outside hosts legitimately export them, so an
operator's terminal would be refused, contradicting D-08.

**Stated limitations.**

- The marker is advisory: a command can unset it. The hard control is the
  `shell_exec` approval itself:
  - in `ask` mode the operator sees the command;
  - in `auto` mode the operator has already accepted that the agent can do
    anything a shell can.

  The refusal exists so that an agent following its tools' contract cannot
  reach the bypass by accident.
- External children (`codex exec`, `claude -p`, via `buildExternalChildEnv`)
  have the whole `KERYX_` namespace swept, so they carry no marker and D-13
  does not cover them. They are opt-in, and their participation is v2 (D-08).

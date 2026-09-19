# Implementation Plan: Keryx Agent Bus
Version: 0.3.0

## Status

P0 is implemented (flow 271, PR #607). P1–P5 are planned and not implemented.
Known P0 limitations: a brand-new session is created a moment before it is
leased; an unreadable owner record reads as unknown rather than lost; cross-host
clock skew is documented only.

Delivery goes through one managed flow per
phase, driven by `flow-orchestrator`, each in its own worktree with a commit at
every task boundary. Acceptance criteria refer to
[specification.md](specification.md) §10.

## Phases

| Phase | Scope | ACs | Depends on |
|---|---|---|---|
| **P0 Session lease** (implemented: flow 271, PR #607) | Scope:<br>• `acquireLeaseSync` in `src/lib/fs.ts`, with the D-09 liveness rule and file I/O shared with `withFileLock`<br>• the lease in `openSession`<br>• `latestUnleasedSession`<br>• live and stale markers in `listSessions` and `keryx sessions list`<br>• `--fork` / `--take-over` and the fork/view/cancel picker<br>• the §6.2 switch order for `/resume`, the startup picker and readline bare `-r` | AC1, AC2, AC3a, AC20, AC22 | none |
| **P1 Bus store and CLI** | Scope:<br>• extract `gitCommonDir`/`gitToplevel` into `src/lib/clone-scope.ts`; allocation behaviour unchanged<br>• `src/bus/`: root resolution from the project root, presence read/write, append under lock with crash-safe `seq`, a reader with an inode-aware cursor and rotation, prune, schema validators, id sanitising<br>• `KERYX_TOOL_CALL=1` set on `shell_exec` children in `resolveShellEnv` (`src/harness/process/shell-spawn.ts`)<br>• `keryx bus list\|log\|send\|prune` with the D-13 marker check and the clone-wide CLI rate limit, registered in the command registry and cli-reference | AC4 (CLI half), AC15, AC16, AC17 (CI and env), AC19, AC21 (send) | P0 (liveness helpers) |
| **P2 Shell integration** | Scope:<br>• `joinBus` and leave in both shell surfaces<br>• the heartbeat, which also refreshes the session lease and its name<br>• the poller<br>• `--name` and `bus.name`<br>• operator rendering of inbound events<br>• the Peers group in the fleet sidebar<br>• the `/bus` modal and non-pause subcommands<br>• `bus` in `classifyBusyDispatch` | AC3b, AC4, AC17, AC18, AC20 | P1 |
| **P3 Agent delivery and tools** | Scope:<br>• `busInbox` with `drainUndelivered`<br>• `buildPeerMessageNotification` and `quarantinePeerMessage`<br>• drains at all three sites in `runAgentTurn` (turn start for `bus-message`, round boundary, post-answer)<br>• the wake trigger on poll and on settle, sharing the auto-wake cap<br>• `ack` writes<br>• `bus_list` and `bus_send` with rate limits<br>• the protocol text from [agent-protocol.md](agent-protocol.md) in the system prompt and tool descriptions | AC5, AC6, AC7, AC8, AC13, AC14 (send refusals) | P2 |
| **P4 Pause leases** | Scope:<br>• lease files and the §4.3 active rule (a stale holder keeps its lease; a lease never applies to its holder)<br>• `pause-request`, `resume`, `override`, and `lease-expired` exactly once under the lock<br>• held turns in `runLine` covering the main agent, side workers, `/queue force` and wakes, with the status-bar banner<br>• `isPublishCommand` and the `publishLease` gate floor<br>• the tool-specific `write` escalation in `executeCall`<br>• `bus_pause`<br>• `keryx bus pause\|resume` and `/bus pause\|resume\|override` | AC9, AC10, AC11, AC12, AC14 (pause refusals), AC21 (pause/resume) | P3 |
| **P5 Docs** | Wiki architecture page `architecture/agent-bus.md`, cli-reference, a roadmap status update, and the end-to-end evidence of the two motivating scenarios on a real two-worktree clone. | PRD success criteria | P4 |

P0 is useful on its own and can ship alone, because it fixes silent session
overwrites.

## Test strategy

- **Pure units:**
  - the liveness and staleness rule, with a fake clock, fake pid probe and
    fake host;
  - name allocation;
  - the lease active rule;
  - `buildPeerMessageNotification`, including escaping and redaction;
  - the publish classifier;
  - `resolveApprovalDecision` with `publishLease` in all three modes and in
    `/plan`;
  - `classifyBusyDispatch` with `bus`.
- **Filesystem integration in a temp git repo with two linked worktrees:**
  - common-dir resolution;
  - concurrent appends from 8 real processes, plus a writer killed mid-append
    (AC15);
  - reading across a rotation where the cursor is beyond the new segment's size
    (AC16);
  - SIGKILL and SIGSTOP recovery (AC3a, AC3b, AC11).
- **Agent loop:** delivery at all three drain sites, including a turn that ends
  in plain text, and never inside a `tool_calls` batch (AC6). These reuse the
  fixtures from `agent-task-notification.test.ts`.
- **Session store:** a regression test that two `-c` opens get different
  sessions (AC1). It must fail on the current `main`.
- **Live check:** a flag-gated smoke test that starts two real PTY shells, as in
  `shell-pty-launch.smoke.test.ts`. It is excluded from CI.

## Rollback

Each phase is additive behind `bus.enabled`. P0 is not behind the flag,
because it is a correctness fix. It can be reverted on its own: without a lease
directory, sessions open exactly as they do today.

## Out of scope (v2 and later)

- `bus.*` MCP tools, and presence or wake for external agents (D-08).
- Role addresses (D-06).
- Idle wake on the readline surface.
- Delivery to subagents and external children.
- Cross-clone or cross-project buses.

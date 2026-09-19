# Implementation Plan

Status: approved for freeze

## Approach

A surface-independent bus client, `src/bus/client.ts`, owns the join, the
timers, the cursor and the rendering hooks. Its clock, timers, liveness and
output sinks are all injectable. The shells call it; they never reimplement it.

## Steps

1. **Bus client (`src/bus/client.ts`).** Model: sonnet.
   - `joinBus({ cwd, sessionId, surface, requestedName, shellConfig, env, sessionLease, statusSource, onEvent, onPeers, now?, timers? })`
     returns either `BusClient` or `{ disabled: reason }`.
   - It resolves the root, allocates the name against live presence, writes
     presence with every §4.1 field, and sets the cursor to the end of the
     log.
   - The heartbeat runs every 5 s. It rewrites presence (status, activity,
     branch, `heartbeatAt`) and calls `sessionLease.refresh({ name })`.
   - The poller runs every `busPollMs`. It calls `readEvents` and filters
     events addressed to this instance: its own id, or `*` when the event is
     not its own. It passes each one to `onEvent` with `displaySafe`
     previews, and refreshes the peer list through `onPeers`.
   - Methods: `setSession(id)`, `rename(name)` (unique among live instances),
     `send(toLabel, kind, body, replyTo?)` with origin `operator` and `from`
     set to self, and `leave()` (remove presence, stop the timers;
     idempotent, synchronous-safe).
   - `sendMessage` gains an explicit `from` and `origin`. The CLI path keeps
     `cli`.
2. **Readline wiring (`src/commands/shell.ts`).** Model: sonnet.
   - Add the `--name` flag with validation (a `ShellFlagError` for reserved
     or invalid names), plus help text.
   - Join after the leased open in `runShell` and `runAgentRepl`. Map the
     status as: turn running → working, otherwise idle.
   - Print event lines through the existing system output.
   - `/bus` text subcommands: `list`, `send`/`@name`, `ask`, `reply`, `name`.
   - Call `leave()` on normal return, on `/exit`, and in `closeAndExit`
     (synchronous, before `process.exit`).
   - Call `setSession()` on `/new`.
3. **TUI wiring (`src/tui/tui-shell.ts`, `worker-fleet.ts`,
   `busy-dispatch.ts`).** Model: sonnet. It runs in parallel with step 2 and
   touches no shell.ts code.
   - Join after the leased startup open.
   - Status comes from `herdrStateFor`, and activity from the `setMainAgent`
     detail or the session title.
   - Render an event as `transcript.add` of `⇄ @from kind: preview`.
   - Add a Peers group below the local workers in `formatFleetSidebar`.
   - Add `/bus` as a modal with tabs Peers, Leases and Log, plus subcommands.
     Add a `bus` target in `classifyBusyDispatch` (conditional-flag pattern)
     so `/bus` works while busy.
   - Call `leave()` in `onDestroy`, `/exit`, the menu exit and `finally`.
   - Call `setSession()` in `applyOpened` and on `/new` and `/resume`.
4. **Process tests.** Model: sonnet.
   - Two readline shells in two linked worktrees list each other in
     `keryx bus list --json` and receive each other's `/bus send` lines.
   - SIGKILL makes presence read gone after the stale window; SIGSTOP makes
     it read stale.
   - SIGTERM removes presence.
   - A disabled bus prints its reason and writes no presence.
   - No child env carries the bus identity.
   - Use short timing knobs, gated like the lease knobs.
5. **Docs status and cli-reference `--name`.** Model: haiku.
6. **Review.** Model: opus. Verification rounds use sonnet.

## Risks

- The `classifyBusyDispatch` signature is shared. Follow the conditional-flag
  pattern used by `isMcp`/`isMcpConsumer`.
- Timers in tests: inject timers and clock rather than relying on real
  intervals.
- The exit paths differ between the TUI (async `onDestroy`) and readline
  (synchronous `closeAndExit`). `leave()` must be synchronous-safe.
- The operator rule applies: only targeted tests run locally. CI decides the
  full suite.

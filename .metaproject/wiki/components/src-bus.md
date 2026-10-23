# Module src/bus

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/bus` is the surface-independent client and storage for the agent bus, which lets keryx shells running in one clone discover each other and exchange messages. It writes an append-only event log, per-instance presence records and pause leases under the git common directory, and exposes `joinBus` as the single join/heartbeat/poll/leave entry point.

## Overview

The bus module lets several concurrently running keryx shells in one clone see each other and pass messages without a server. It owns the on-disk bus (the event log, presence records, pause-lease files and head pointer), the record contracts that readers and writers validate against, and the client that a shell uses to join, heartbeat, poll and leave. The header of `src/bus/client.ts` names `src/commands/shell.ts` (readline) and `src/tui/tui-shell.ts` (TUI) as its only callers, and both wire rendering callbacks rather than reimplementing the sequence.

## How it works

The module is layered from storage up to the client, with each layer kept free of the one above it.

- **Paths** (`src/bus/paths.ts`): `busRootFor` and `resolveBusRoot` pick one bus directory per project, `<git-common-dir>/keryx/bus/<project-key>`, so every linked worktree of a clone shares it. Outside git it falls back to the data directory. This file does no I/O; it only builds paths and validates ids (`assertBusId`) before any path is joined.
- **Schema** (`src/bus/schema.ts`): the contracts for `BusEvent`, `PresenceRecord` and `PauseLease`, mirrored inline from the requirement docs and checked by `busEventProblems`, `presenceProblems` and `pauseLeaseProblems`. Readers skip an invalid record and never throw; writers refuse it. Reserved names (`all`, `cli`, `system`) and the 2048-byte body bound are enforced here or in the writer.
- **Log** (`src/bus/log.ts`): `appendEvent` runs under `append.lock`, takes `seq` as the highest of `head.json` and the last complete line plus one, rotates the segment past 1 MiB, and rewrites `head.json`. `readEvents` reads from a `BusCursor` of segment, inode, offset and seq. It opens the current segment before listing rotated ones, so a rotation in between cannot skip a segment.
- **Presence** (`src/bus/presence.ts`): `writePresence` stores one file per instance, and `classifyPresence` labels each record `live` (heartbeat within 15 s), `stale` (same host, pid alive) or `gone`. `allocateName` gives a free name, or a `-2`, `-3` suffix when a live peer holds the requested one.
- **Client** (`src/bus/client.ts`): `joinBus` composes the layers above into a `BusClient`. It resolves the root, allocates a name, writes presence, positions the cursor at the end of the log, and starts a heartbeat timer and a poll timer. Clock, timers, pid liveness, host name and branch lookup are all injectable so tests run without real waits.
- **Errors** (`src/bus/errors.ts`): `BusRefusal` carries a stable `code` (for example `name-taken`, `body-too-large`, `rate-limited`) so callers can branch on it without parsing messages.

Sending is delegated to `sendMessage` from `src/bus/send.ts`, which `send`, `reply` and their agent-origin variants call. Those variants differ only in the `origin` they stamp on the sender.

## Key concepts

- **Bus root and project key**: the directory holding one project's bus. The key is the project path inside the repository, slugified (`slugifyProjectPath`), or `root`.
- **Instance**: one joined shell, identified by `instanceId` from `processInstanceId()`. It has a human-readable `name` that `allocateName` assigns (`agent-<n>` by default) and that `rename` can change while the name stays unique among live peers.
- **Event (`BusEvent`)**: one append-only log line with `seq`, `id`, `from` (instance, name and `origin`: `agent`, `operator`, `cli` or `system`), `to` (recipient instance ids, or `["*"]` for everyone) and a `kind`. Kinds include `notice`, `question`, `reply`, `handoff`, `pause-request`, `resume`, `override`, `ack` and `lease-expired`. A `reply` refers back through `refs.replyTo`.
- **Rendered event (`RenderedBusEvent`)**: what a shell sees after `doPoll`. System kinds (`ack`, `override`, `lease-expired`) are never rendered. The `preview` is capped at 160 characters, and the full `body` is kept for agent delivery.
- **Presence record (`PresenceRecord`)**: a heartbeat from one instance, with its `pid`, `host`, `checkout`, `branch`, `surface` (`tui` or `readline`), `status` (`idle`, `working`, `blocked` or `held`) and an `activity` string capped at 120 characters.
- **Pause lease (`PauseLease`)**: a holder asks its targets to pause. It has a `scope` (`turns`, `git-publish` or `advisory`) and an expiry at most 4 hours after creation. It is active while its file under `leases/` exists, so removing the file is enough to release it.
- **Ref resolution**: `resolveRef` maps `#12`, `12`, or a unique id prefix of at least 8 characters to an event from the last 200 rendered ones, so `reply` can address the original sender even after a rename.

The core relationships are that events are addressed to instance ids, presence says which instances are alive, and leases constrain the targets they name.

## Main flows

1. **Join.** `joinBus` returns `{ disabled }` when `busEnabled` says so. Otherwise it resolves the root, reads presence to find the live names, and calls `allocateName`. It registers the process `exit` hook before the first write, then writes presence, sets the cursor with `cursorAtEnd`, and refreshes the lease view. If anything after the presence write throws, it calls `leave()` and rethrows, so no presence record is orphaned.
2. **Receive.** Each `pollTick` (default every `busPollMs`) runs `doPoll`. That calls `readEvents` from the cursor, keeps the events `addressedToMe` selects, and renders the renderable kinds into `RenderedBusEvent`s. Each is offered to `onEvent` inside its own try/catch, and the cursor advances only after the whole batch has been offered. The poll then refreshes peers through `listPresence`, `toPeers` and `onPeers`, and refreshes the lease view.
3. **Leave.** `leave()` is idempotent. It clears both timers, removes the exit hook, and runs `syncResumeOwnLeases`. That synchronously deletes the lease files this instance holds and appends a best-effort `resume` event. Then it removes the presence file with `removePresenceSync`. The shell calls it on its own shutdown path, and the exit hook calls it on a plain exit. A SIGKILL skips all of this, and peers then expire the instance through the liveness rule in `classifyPresence`.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `DEFAULT_HEARTBEAT_MS`
- `RenderableBusEventKind`
- `RenderedBusEvent`
- `ResolvedBusRef`
- `BusPeer`
- `BusClientSessionLease`
- `BusSessionLeaseGetter`
- `BusErrorWhere`
- `BusTimers`
- `JoinBusOptions`
- `BusClient`
- `joinBus`
- `BusRootKind`
- `BusRoot`
- `BusRootInput`
- `slugifyProjectPath`
- `busRootFor`
- `resolveBusRoot`
- `BUS_UUID_PATTERN`
- `isBusId`

### Key files

- `src/bus/client.ts` - imported by 26, imports 14
- `src/bus/paths.ts` - imported by 24, imports 3
- `src/bus/schema.ts` - imported by 26, imports 1
- `src/bus/presence.ts` - imported by 19, imports 6
- `src/bus/log.ts` - imported by 17, imports 6
- `src/bus/errors.ts` - imported by 17, imports 0

### Depends on

- `src/lib` - 7 import(s)
- `src/session` - 3 import(s)
- `src/harness/child` - 2 import(s)
- `src/security` - 2 import(s)
- `src/harness/tool/builtin` - 1 import(s)
- `src/capability` - 1 import(s)

### Depended on by

- `src/commands` - 24 import(s)
- `src/tui` - 15 import(s)

### Dependency basis

- Production imports only: 46 import(s) from test file(s) (e.g. `src/acp/roster.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 35
- Cross-module imports: 17

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/session](src-session.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/security](src-security.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
- [Module src/capability](src-capability.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.

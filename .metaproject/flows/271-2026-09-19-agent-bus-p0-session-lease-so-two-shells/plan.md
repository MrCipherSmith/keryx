# Implementation Plan

Status: approved for freeze

## Approach

All leasing lives in one new module, `src/session/lease.ts`. Every surface
opens, switches and closes a session through it. `openSession` itself does not
change unless a lease is asked for.

## Steps

1. **Primitive in `src/lib/fs.ts`.**
   - `acquireLeaseSync(lockPath, owner, { staleMs, now?, isAlive?, host? })`
     returns either:
     - `{ ok: true, handle: { owner, refresh(patch?), release() } }`, or
     - `{ ok: false, holder, state: "live" | "stale" }`.
   - `reclaimStaleLeaseSync` performs an explicit take-over, and refuses when
     the holder is live.
   - It is synchronous: `mkdirSync(…, 0o700)`, then `owner.json` written `wx`
     with mode 0o600, and `refresh()` rewrites it atomically (temp file, then
     rename).
   - Liveness follows D-09, which is not `withFileLock`'s rule:
     - **live**: `heartbeatAt` is at most `staleMs` old;
     - **stale**: older than that, same host, and the pid is alive;
     - **gone**: anything else, reclaimed silently.
   - `processIsAlive` is exported. `withFileLock` does not change.
   - The clock, pid probe and host are injectable.
2. **`src/session/lease.ts`.**
   - `processInstanceId()` returns one UUID per process.
   - `sessionLeaseState` returns `free`, `mine`, `live` or `stale`, plus the
     holder.
   - `latestUnleasedSession` skips `live` and `stale` sessions.
   - `SessionLeasedError` carries `{ summary, holder, state }`.
   - `openLeasedSession`:
     - `continueLast` goes through `latestUnleasedSession` and reports a
       skipped held session;
     - `resumeId` on a held session throws, unless `takeOver` is set and the
       holder is stale;
     - `fork` forks the source, then leases the fork;
     - it starts an unref'd 5 s heartbeat and registers a synchronous release on
       `process.on("exit")`.
   - `switchLeasedSession(current, target)` acquires the target lease first,
     then releases the current one. When it refuses, the current lease is left
     untouched.
   - `releaseSessionLease` is idempotent.
   - Every call site sits inside `try {` (per `store.callers.test.ts`). If the
     config-dir writer/reader tests flag `lease.ts`, add an exemption like
     store's and record it in the journal.
3. **Readline (`src/commands/shell.ts`).**
   - New flags `--fork` and `--take-over`, valid only with `-r <id>`. Refuse
     `-r --take-over` (the peek would read the flag as an id) and both flags
     together.
   - `runShell` and `runAgentRepl` open through `openLeasedSession`.
     - Their `catch` rethrows `SessionLeasedError`.
     - The top level handles it: on a TTY, a numbered prompt; without a TTY,
       exit 1 with the spec message.
   - `/new` in both loops goes through `switchLeasedSession`.
   - Bare `-r` uses `latestUnleasedSession`.
   - `closeAndExit` and the normal return release the lease.
   - Update the help text.
4. **TUI (`src/tui/tui-shell.ts` and the chat-TUI path in `shell.ts`).**
   - The six startup opens go through `openLeasedSession`.
   - The startup `catch` handles `SessionLeasedError` with a composer choice:
     fork, view, cancel, plus take over when the holder is stale.
     - View renders `exportSessionMarkdown` read-only, then starts a new
       session.
   - `applyOpened`, `/resume` and `/new` go through `switchLeasedSession`.
   - The picker and the Session Switcher mark rows `● live` or `◌ stale`.
   - `onDestroy` and the outer `finally` release the lease.
   - The chat TUI's bare `-r` uses `latestUnleasedSession`.
5. **`keryx sessions list`.**
   - Add a LIVE column and a `live` field in `--json`.
   - Update the help text and `docs/docs/cli-reference.md` (the shell flags and
     `sessions list`).
6. **Documentation status.** Mark P0 as implemented in the package README, the
   implementation plan and the roadmap row.

## Rejected

- **Leasing inside `openSession`.** It breaks five store tests that open a
  session and then `continueLast` in the same process, and it ties process
  lifetime to a pure store function.
- **`withFileLock`'s liveness rule.** "A live pid wins" means a reused pid keeps
  a crashed shell looking alive. D-09 rejects that rule.
- **An async lease.** `openSession` and all six TUI call sites are synchronous.

## Risks

- **Refusals swallowed by catch-all blocks.** `catch` blocks at `shell.ts:265`
  and `:1466` and at `tui-shell.ts:4226` turn any open error into a new session.
  A typed error that they rethrow covers this, and AC2 tests it.
- **Exit paths.** Readline calls `process.exit` on a signal, and the TUI's
  `onDestroy` is synchronous. The release is synchronous and idempotent and also
  runs on `process.on("exit")`.
- **Help text contradicts the change.** `shell.ts:2294` and
  `cli-reference.md:113` promise the old `-c` and bare `-r` behaviour. AC10
  covers the update.
- **Stale installed binary.** Per memory, `keryx` on PATH is a stale build, so
  subprocess tests must run the working tree (`bun src/cli.ts`), not `keryx`.

# Flow Journal

- 2026-09-19T13:06:03.981Z - flow created
- 2026-09-19T13:12:20.601Z - task-added: T5: Lease primitive in src/lib/fs.ts: acquireLeaseSync, reclaimStaleLeaseSync, D-09 liveness, exported processIsAlive, unit tests
- 2026-09-19T13:12:20.692Z - task-added: T6: Session lease module src/session/lease.ts: instance id, lease state, latestUnleasedSession, SessionLeasedError, openLeasedSession, switchLeasedSession, release, heartbeat, unit tests
- 2026-09-19T13:12:20.775Z - task-added: T7: Readline wiring in shell.ts: --fork/--take-over flags and validation, leased open, TTY choice and non-TTY exit, /new switch, bare -r, release on exit, help
- 2026-09-19T13:12:20.859Z - task-added: T8: TUI wiring: leased startup opens, fork/view/cancel/take-over choice, applyOpened//resume//new switch, live/stale picker labels, release in onDestroy and finally, chat-TUI bare -r
- 2026-09-19T13:12:20.948Z - task-added: T9: keryx sessions list LIVE column and --json live field; cli-reference for shell flags and sessions list
- 2026-09-19T13:12:21.032Z - task-added: T10: Subprocess verification: two -c shells (AC1), SIGKILL and SIGSTOP holders with short staleMs (AC5), SIGTERM release (AC7)
- 2026-09-19T13:12:21.121Z - task-added: T11: Mark P0 implemented in the agent-bus package README, implementation-plan and roadmap row
- 2026-09-19T13:12:21.201Z - task-added: T12: Verification: typecheck, lint and full test suite green; record results
- 2026-09-19T13:12:27.292Z - task-done: T1: Collect remaining context
- 2026-09-19T13:12:27.371Z - task-done: T2: Implement per plan
- 2026-09-19T13:12:27.443Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-19T13:12:27.590Z - frozen: 12 criteria; checksum recorded
- 2026-09-19T13:12:27.745Z - started
- 2026-09-19T13:12:42.904Z - task-attempt: T5: started (attempt 1) — 271-T5T6 dispatch
- 2026-09-19T13:12:42.981Z - task-attempt: T6: started (attempt 1) — 271-T5T6 dispatch
- 2026-09-19T13:23Z - orchestrator: 271-T5T6 returned DONE_WITH_CONCERNS.
  - Orchestrator re-ran fs.lease, lease, store, store.callers and fs tests: 74 pass, 0 fail.
  - Worker reported tsc clean and eslint clean.
  - Decision on each concern, all accepted:
    1. `reclaimStaleLeaseSync(lockPath, owner, opts)` removes and acquires in one call. Accepted: no window for a third process.
    2. `refresh()` returns false after the lease is lost and never overwrites another holder's record. Accepted.
    3. Opening a session this process already holds (state `mine`) returns the existing handle, so `/resume` of the current session is not refused against itself. Accepted.
    4. `SessionLeasedError.holder` can be undefined while the holder is still starting. Accepted; the message says so.
    5. Test-only env `KERYX_SESSION_LEASE_STALE_MS` / `KERYX_SESSION_LEASE_HEARTBEAT_MS`, needed for T10. Accepted; an explicit option wins.
    6. `openLeasedSession` is not registered in `store.callers.test.ts` THROWING_READERS, to keep AC9's "unmodified". T7/T8 must still place every call inside `try {`. The T7/T8 dispatches and review check this by hand.
    7. No config-dir exemption was needed.
    8. Small race: a brand-new session is created before it is leased. The window is synchronous and tiny. Accepted and recorded as a known limitation.
    9. `lease.test.ts` has a minimal schema checker (the repo has no JSON Schema validator), plus a negative test.
  - Env: the worktree had no node_modules. The orchestrator ran `bun install --frozen-lockfile`.
  - `security-pre-push.test.ts` and `git-hooks.test.ts` fail locally because a repo hook refuses a test's author email. The failure comes from the environment and is unrelated to this change; CI decides (AC11).
- 2026-09-19T13:24:01.856Z - task-done: T5: Lease primitive in src/lib/fs.ts: acquireLeaseSync, reclaimStaleLeaseSync, D-09 liveness, exported processIsAlive, unit tests
- 2026-09-19T13:24:01.930Z - task-done: T6: Session lease module src/session/lease.ts: instance id, lease state, latestUnleasedSession, SessionLeasedError, openLeasedSession, switchLeasedSession, release, heartbeat, unit tests
- 2026-09-19T13:24:14.417Z - task-attempt: T7: started (attempt 1) — 271-T7 dispatch
- 2026-09-19T13:40:19.636Z - task-attempt: T7: failed (attempt 2) — dispatch 271-T7 interrupted by operator mid-run; partial edits in shell.ts/shell-types.ts kept
- 2026-09-19T13:40:19.734Z - task-attempt: T7: started (attempt 3) — 271-T7b resume over partial edits
- 2026-09-19T13:40:55.606Z - task-attempt: T9: started (attempt 1) — 271-T9 dispatch (parallel with T7b, disjoint files)
- 2026-09-19T13:41Z - orchestrator: T7 `attempts.count` reads 3, but only one real try has been made so far. The count records three events:
  1. the first dispatch started;
  2. the operator interrupted it (recorded as failed);
  3. dispatch 271-T7b resumed over the partial edits.

  The operator chose "resume over partial edits" rather than a restart. If T7b fails, re-plan instead of re-dispatching the same approach.
- 2026-09-19T13:43:10.670Z - task-done: T9: keryx sessions list LIVE column and --json live field; cli-reference for shell flags and sessions list
- 2026-09-19T13:43Z - orchestrator: 271-T9 returned DONE and was committed as de242b89. Orchestrator re-ran `bun test src/commands/sessions`: 11 pass. `sessions.ts` imports `sessionLeaseState` from `../session/lease` directly, because it is not re-exported from the barrel. Accepted.
- 2026-09-19T13:50Z - orchestrator: 271-T7b returned DONE_WITH_CONCERNS. It kept the interrupted run's work and completed the flags, the top-level choice, bare `-r`, the signal release and the help text. Orchestrator re-ran `bun test src/commands/shell src/session src/lib/fs src/cli.test.ts`: 354 pass, 2 skip, 0 fail. tsc is clean. No existing test was edited. Concerns:
  1. The chat TUI calls `runShell`, which now throws `SessionLeasedError`. The TUI must catch it. This goes to T8.
  2. The chat-TUI bare `-r` pre-resolve is still unchanged. This goes to T8.
  3. `cli.ts` now honours a positive integer `exitCode` on any thrown error (`ShellFlagError` uses 2). Reviewed: no existing thrown error class sets `exitCode`, and the other hits are all `process.exitCode` assignments. Any failure still exits non-zero. Accepted.
  4. The refused-`/new` test covers only the chat loop, because `runAgentRepl` is not exported. The agent loop shares the switch code. Accepted. T10's subprocess tests exercise the agent path.
  5. A REPL that throws mid-loop releases its lease only through `process.on("exit")`. Accepted: that hook is synchronous and idempotent.
  - T8 must add `fork?`/`takeOver?` to the TUI session opts type (around tui-shell.ts:2841). It compiles today only through a spread.
- 2026-09-19T13:50:57.655Z - task-done: T7: Readline wiring in shell.ts: --fork/--take-over flags and validation, leased open, TTY choice and non-TTY exit, /new switch, bare -r, release on exit, help
- 2026-09-19T13:51:04.466Z - task-attempt: T8: started (attempt 1) — 271-T8 dispatch
- 2026-09-19T14:04Z - orchestrator: 271-T8 returned DONE_WITH_CONCERNS.
  - Orchestrator re-ran the tests: `bun test src/tui src/commands/shell src/commands/sessions src/session src/lib/fs src/lib/config-dir src/cli.test.ts`, 1265 pass, 2 skip, 0 fail. tsc is clean. No existing test was edited.
  - The shared choice list now lives in `src/session/lease-choice.ts`, so the TUI does not import `commands/shell`.
  - A held `/resume` target is refused with a `--fork` hint, and the current session and lease are kept. Accepted: spec §6.2 only requires the refusal and keeping the lease.
  - Concerns:
    1. `/new` closes the slate before the new open. If that open fails for a reason other than a lease, the session stays but its slate is closed. A new session is always lease-free. Accepted; follow-up candidate.
    2. The chat-TUI prompt needs an explicit `1`, because the composer ignores empty lines. Accepted.
    3. The TUI half of AC7 is covered by source-text audits plus real-lease tests of `createTuiLeaseHolder`. The subprocess proof is T10.
    4. `openLeasedSession(` is not in the store.callers guard list. The one call sits inside `try`, and review checks it.
- 2026-09-19T14:04:42.236Z - task-done: T8: TUI wiring: leased startup opens, fork/view/cancel/take-over choice, applyOpened//resume//new switch, live/stale picker labels, release in onDestroy and finally, chat-TUI bare -r
- 2026-09-19T14:04:47.958Z - task-attempt: T10: started (attempt 1) — 271-T10 dispatch
- 2026-09-19T14:12:09.730Z - task-done: T10: Subprocess verification: two -c shells (AC1), SIGKILL and SIGSTOP holders with short staleMs (AC5), SIGTERM release (AC7)
- 2026-09-19T14:12:17.834Z - task-attempt: T12: started (attempt 1) — local lint+typecheck+full suite

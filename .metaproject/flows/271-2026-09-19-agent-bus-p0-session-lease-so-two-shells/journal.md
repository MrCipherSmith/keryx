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

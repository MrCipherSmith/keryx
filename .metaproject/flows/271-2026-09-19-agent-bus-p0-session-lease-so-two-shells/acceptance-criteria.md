# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Two `keryx shell -c` processes started one after the other in one project (isolated data dir) open two different session ids, and the second prints a line naming the session it skipped and its holder pid; proven by a subprocess test running the working tree.
- AC2: `keryx shell -r <id>` without a TTY, on a session whose lease is held by a live process, exits non-zero without writing that session's context.jsonl, archive.jsonl or summary.json, and its message contains `--fork`; with `--fork` it opens a new forked session and holds that fork's lease; proven by tests.
- AC3: With a TTY, a leased `-r <id>` offers fork, view and cancel (plus take over only when the holder is stale) on both the readline and TUI surfaces; view renders the session read-only and then starts a new session; cancel exits without opening any session; proven by unit tests of the choice handling on each surface.
- AC4: Bare `-r` never selects a leased session: the readline non-TTY fallback and the chat-TUI pre-resolve use the latest unleased session, and the TUI startup picker and Session Switcher label leased rows live or stale; proven by tests.
- AC5: After the holder is killed with SIGKILL its lease is reclaimed by the next open once heartbeatAt is older than staleMs; while the holder is stopped with SIGSTOP (same host, pid alive) the lease reads stale, `-c` still skips it and `-r <id> --take-over` succeeds; `--take-over` against a live holder is refused; proven by a subprocess test with an injected short staleMs.
- AC6: Every in-process switch (TUI `/resume`, TUI `/new`, readline `/new` in the chat and agent loops, TUI startup picker) acquires the target lease before releasing the current one, and a refused target leaves the current session open with its lease intact; proven by tests.
- AC7: The lease directory is removed on readline `/exit`, readline SIGINT and SIGTERM, TUI `/exit` and TUI Ctrl+C (onDestroy); proven by tests including a subprocess SIGTERM test.
- AC8: owner.json validates against docs/requirements/keryx-agent-bus/schemas/session-lease.schema.json, has mode 0600 inside a 0700 directory, carries name null, is refreshed with a new heartbeatAt every 5 s by an unref'd timer, and release() removes the lease only when the token matches; proven by unit tests.
- AC9: `openSession` without the lease path behaves exactly as before: every pre-existing test in src/session/store.test.ts and src/session/store.callers.test.ts passes unmodified, and withFileLock and isLockHeld behaviour and tests are unchanged.
- AC10: `keryx sessions list` shows a LIVE column (live, stale or blank) and `--json` rows carry a `live` field; `keryx shell --help` and docs/docs/cli-reference.md document `--fork`, `--take-over` and the new `-c` and bare `-r` behaviour; `--fork` or `--take-over` without `-r <id>`, and both together, are refused with a message; proven by tests.
- AC11: typecheck, lint and the full test suite are green on the PR head in CI.
- AC12: The keryx-agent-bus package README, implementation-plan.md and the roadmap row state P0 as implemented with the flow and PR reference, and state P1 to P5 as not implemented.

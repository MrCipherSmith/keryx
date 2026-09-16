# Flow Journal

## T5 result — 19 RED tests, 0 pass, and one consequence worth naming

`src/commands/shell-task-tools.test.ts`: 19 tests, **0 pass / 19 fail**, every
failure the right kind — a missing export (`shellTaskOutputTool`,
`shellTaskWaitTool`, `shellTaskKillTool`, `clampTaskWaitMs`, `demoteTask`,
`parseDemoteCommand`) or missing behaviour (`invoke` still takes one argument, so
no tool can see the turn's signal). Nothing failed on a parse error, which is the
point of reading not-yet-existing exports off the module namespace rather than
importing them by name: in Bun a named import of a missing export takes the whole
file down with one unreadable message.

**Consequence P2 has to accept:** two criteria are about what a set CONTAINS —
AC9 (`SIDE_WORKER_DENIED_TOOL_NAMES`) and AC11 (`REPEATABLE_TOOL_NAMES`) — and
both sets are module-private today (`tui-shell.ts:245`, `agent.ts:456`). A
criterion nobody can observe is one nobody can check, so this phase exports them.
That is a real widening of two modules' surfaces, done deliberately rather than
worked around with a source-text audit.

**Correction made before any test was written.** The plan first said "one handler
serves both shells" for `/demote`. Reading the dispatch showed no such mechanism:
`AGENT_SLASH_COMMANDS` carries metadata only, `findAgentCommand` merely resolves
a line to an entry, and each shell dispatches in its own branch (`shell.ts`'s
if/else chain, `tui-shell.ts:4441` and `:4656`). `/delegate` is the real pattern —
a pure parser exported from the registry module, the effect left to each shell —
and it is wired in the TUI only, so "the registry has a parser" does not by
itself put a command in both shells. AC8 stands as frozen (it asks for an
EXECUTED handler); the plan was corrected instead, in its own commit, before the
tests were written against an imagined seam.

## T10/T11 — two findings the wiring produced, both worth keeping

1. **A capability available only when it is not needed.** `/demote` first went
   into the TUI's ordinary dispatch alone. But `classifyBusyDispatch`
   (`src/tui/busy-dispatch.ts`) is an ALLOW-LIST: anything it does not name is
   `deferred`, i.e. queued behind the busy turn. Demote's whole reason for
   existing is a turn blocked on its own command, so shipping it outside that
   list would have produced a command that works exactly when nobody wants it.
   It is now a named target there, mirrored in the live if-chain the classifier
   exists to predict.

2. **A source-text audit that pinned a literal.** Flow 173's F-003 audit asserted
   the exact string
   `const SIDE_WORKER_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set(["shell_job_kill"]);`.
   Widening that list broke it — not because the invariant changed, but because
   the audit pinned the SPELLING rather than the property. Rewritten to assert
   what it was protecting (a module-level, name-based deny list that names
   `shell_job_kill`), plus a second test for the new membership: kill, wait and
   the implicit-cursor read are denied, and `shell_task_output` deliberately is
   not. The lesson generalises to every audit this package has written: pin the
   property, never the punctuation.

**Design point worth keeping.** `demoteTask` refuses a task that is already in
the background, while `registry.promote()` deliberately does not. The same
operation is right to be forgiving on the yield path — it promotes a task it has
just watched time out — and wrong for an operator command, where "already
demoted" is a mistake worth saying out loud instead of a silent success. The rule
lives with the registry rather than in either shell, so both dispatch into one
rule instead of growing two.

Also settled here: both name sets are now EXPORTED, because AC9 and AC11 are
about what they contain. The alternative was a source-text audit, and the point
above is exactly why that would have been the weaker choice.

## T13 — the review found a hole in this flow's OWN frozen criterion

`resolveTaskId` swapped `job-<n>-<pid>` to `task-<n>-<pid>` for every caller,
including both kill paths and demote. Every id in a live session is `task-*`, so
that swap can only ever fire for an id from an EARLIER session — which D-14 says
must be a dead reference, because tasks do not survive a session. The swap keeps
the counter and the pid; a session's counter restarts at 1, so a stale
`job-5-<pid>` matches a live `task-5-<pid>` whenever that pid is recycled. For a
read that is a wrong answer; for `shell_job_kill` it is somebody else's work
destroyed, and D-14's guarantee is what the swap quietly weakened.

The uncomfortable part: **AC5, which I wrote and froze in this flow, required the
hole.** "Both aliases accept BOTH spellings" cannot be satisfied without letting
an action resolve a dead id onto a live task. So the finding was not just about
code — it was about a criterion that had never been checked against the package's
own decisions. Raised to the owner with options rather than quietly re-scoped;
the decision was reads-only. AC5 was narrowed through `keryx flow ac update`,
re-sealed, and the acting paths now take the id exactly as given.

Two process notes worth keeping:

- `keryx flow ac update <id> --reason "…"` does NOT edit a criterion. It
  re-freezes whatever the file currently holds and clears prior confirmations, so
  the order is: EDIT the criterion, then run it. Running it first (as I did)
  seals the old text and the edit breaks the seal again.
- Re-sealing cleared the confirmations, which is the right behaviour — a
  confirmation attests to a specific wording — and it means all twelve criteria
  must be confirmed again before the completion gate will pass.

The evidence for the fix is a new test rather than a probe, and deliberately so:
a pid collision cannot be staged on demand, so the claim is proved by pinning the
invariant (a kill with the old spelling is refused, the task stays `running`,
while the read alias still accepts both) instead of by staging the coincidence.

- 2026-09-16T13:03:29.197Z - flow created
- 2026-09-16T13:16:03.424Z - frozen: 12 criteria; checksum recorded
- 2026-09-16T13:16:03.525Z - started
- 2026-09-16T13:16:45.648Z - task-added: T5: RED tests for AC1-AC12 across registry, tool surface, agent loop and both shells
- 2026-09-16T13:16:45.751Z - task-added: T6: Tool contract: invoke(input, ctx) and executeCall passes the turn's abort signal
- 2026-09-16T13:16:45.848Z - task-added: T7: shell_task_output with an explicit cursor, plus the observer split on the tool factory
- 2026-09-16T13:16:45.943Z - task-added: T8: shell_task_wait: any/all, the [0,300000] clamp, abort via ctx.signal, never kills
- 2026-09-16T13:16:46.101Z - task-added: T9: shell_task_kill, the two aliases with both id shapes, and their deprecation notes
- 2026-09-16T13:16:46.386Z - task-added: T10: /demote <task_id> in both shells through the shared command registry
- 2026-09-16T13:16:46.628Z - task-added: T11: Side-worker denial over the real roster, and REPEATABLE_TOOL_NAMES
- 2026-09-16T13:16:46.751Z - task-added: T12: Verify: typecheck, named suites, full suite, live abort-does-not-kill smoke, health
- 2026-09-16T13:16:46.869Z - task-added: T13: Review round ingested against the head that will merge
- 2026-09-16T13:16:47.132Z - task-added: T14: Journal deviations and mark P2 in the requirements package
- 2026-09-16T13:17:10.791Z - task-done: T1: Collect remaining context
- 2026-09-16T13:17:10.890Z - task-done: T2: Implement per plan
- 2026-09-16T13:17:10.994Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-16T13:17:11.104Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-16T13:17:11.200Z - task-attempt: T5: started (attempt 1) — RED tests for AC1-AC12: behaviour proven by execution wherever a seam exists; source audits only for the two REPL loops that have none
- 2026-09-16T13:23:16.347Z - task-done: T5: RED tests for AC1-AC12 across registry, tool surface, agent loop and both shells
- 2026-09-16T13:23:16.547Z - task-attempt: T6: started (attempt 1) — tool contract: invoke(input, ctx) and executeCall passing the turn's abort signal
- 2026-09-16T13:26:59.393Z - task-done: T6: Tool contract: invoke(input, ctx) and executeCall passes the turn's abort signal
- 2026-09-16T13:26:59.555Z - task-attempt: T7: started (attempt 1) — shell_task_output with an explicit cursor, plus the observer split (main marks observed, side never does)
- 2026-09-16T13:31:20.360Z - task-done: T7: shell_task_output with an explicit cursor, plus the observer split on the tool factory
- 2026-09-16T13:31:20.454Z - task-attempt: T8: started (attempt 1) — shell_task_wait: any/all, the [0,300000] clamp, abort via ctx.signal, never kills
- 2026-09-16T13:33:25.432Z - task-done: T8: shell_task_wait: any/all, the [0,300000] clamp, abort via ctx.signal, never kills
- 2026-09-16T13:33:25.532Z - task-attempt: T9: started (attempt 1) — shell_task_kill, both aliases accepting task-* and job-* ids, and their deprecation notes
- 2026-09-16T13:35:56.857Z - task-done: T9: shell_task_kill, the two aliases with both id shapes, and their deprecation notes
- 2026-09-16T13:35:56.982Z - task-attempt: T10: started (attempt 1) — /demote <task_id>: registry entry, pure parser, and the promote() effect helper both shells call
- 2026-09-16T13:44:37.252Z - task-done: T10: /demote <task_id> in both shells through the shared command registry
- 2026-09-16T13:44:37.342Z - task-done: T11: Side-worker denial over the real roster, and REPEATABLE_TOOL_NAMES
- 2026-09-16T13:44:37.438Z - task-attempt: T12: started (attempt 1) — verify: typecheck, named suites, full suite, live abort-does-not-kill smoke, health
- 2026-09-16T14:09:50.308Z - task-done: T12: Verify: typecheck, named suites, full suite, live abort-does-not-kill smoke, health
- 2026-09-16T14:09:50.413Z - task-attempt: T13: started (attempt 1) — review round, ingested LAST against the head that will merge (flow 265's gate refused a round run against a stale SHA)
- 2026-09-16T14:11:00.862Z - task-done: T14: Journal deviations and mark P2 in the requirements package
- 2026-09-16T14:16:48.391Z - ac-updated: review finding: AC5 as frozen required both id spellings on BOTH aliases, which conflicts with D-14 (tasks do not survive a session, so a stale handle must resolve to unknown task_id). Resolving spellings on a KILL can land on a live task when the pid is recycled. Narrowed to reads only, by the owner's decision.
- 2026-09-16T14:18:18.953Z - ac-updated: AC5 narrowed to reads-only id resolution after the review finding; re-sealing against the corrected text (the previous re-seal captured the old wording, because the command re-freezes current content rather than editing a criterion)

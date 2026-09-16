# Flow Journal

## Design refinements found while locating the seams

- **The readline race sits in the one loop that also detects EOF.**
  `src/commands/shell.ts:1371-1380`: `for(;;) { const line = await readLine(); if
  (line === undefined) { …sweep…; return; } }`. Racing input against completions
  must not swallow that `undefined` — end-of-input still has to close the slate
  session and sweep. So the race resolves to a tagged value (`{kind:"line"}` /
  `{kind:"completion"}`), never to a bare string, and EOF keeps its own branch.
- **The TUI completion subscription cannot live beside the event one.**
  `setBackgroundJobListener` is registered at `tui-shell.ts:2678`, where the
  store is fed, but `runLine` is only defined at `:4422`. The wake therefore
  subscribes after `runLine` exists rather than at the existing sink — or the
  listener would close over a binding that is not initialised yet (TDZ), the
  same hazard the flow-173 exit sweep documents.
- **Two settle handlers, not one.** `:5161` is the wiki-enrich path and `:5263`
  the main-turn path; both drain `mainQueue`. An idle wake must be considered in
  the main-turn one only, and only when `forceHandoff` has nothing pending and
  the queue is empty — otherwise a notification could jump an operator item.
- **Registry wiring points:** `shell.ts:2085` (TUI, already passes `onEvent`)
  and `:2453` (readline, currently passes nothing). `onCompletion` attaches at
  both; the readline one is the reason a `--no-tui` session can wake at all.


- 2026-09-16T10:47:30.558Z - flow created
- 2026-09-16T10:50:24.599Z - task-done: T1: Collect remaining context
- 2026-09-16T10:50:24.705Z - task-done: T2: Implement per plan
- 2026-09-16T10:50:24.811Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-16T10:50:24.900Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-16T10:50:24.985Z - task-added: T5: RED tests for AC1-AC11
- 2026-09-16T10:50:25.076Z - task-added: T6: Registry: observed, drainUndelivered, onCompletion, hold-timeout kill reason
- 2026-09-16T10:50:25.163Z - task-added: T7: Agent loop: drain at the round boundary and build the notification message
- 2026-09-16T10:50:25.253Z - task-added: T8: Agent loop: hold the turn at the text-only finish for sessions that cannot be woken
- 2026-09-16T10:50:25.338Z - task-added: T9: Shells: readline input-vs-completion race, TUI idle wake, wake cap and reset
- 2026-09-16T10:50:25.423Z - task-added: T10: Verify: typecheck, P0 regression suites, real --print hold smoke
- 2026-09-16T10:50:25.514Z - task-added: T11: Review the P1 diff and fix findings
- 2026-09-16T10:50:25.610Z - task-added: T12: Journal deviations and mark P1 in the requirements package
- 2026-09-16T10:50:45.769Z - frozen: 11 criteria; checksum recorded
- 2026-09-16T10:50:45.864Z - started
- 2026-09-16T10:51:08.878Z - task-attempt: T5: started (attempt 1) — 265-T5 tests-creator dispatch (RED tests for AC1-AC10)

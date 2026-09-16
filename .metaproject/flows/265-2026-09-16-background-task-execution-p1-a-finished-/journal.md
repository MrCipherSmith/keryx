# Flow Journal

## T5 result (DONE_WITH_CONCERNS) — accepted

RED run: 51 pass / 25 fail across `background-job-registry.test.ts` +
`agent-task-notification.test.ts` (16 new tests there), and 173 pass / 8 fail
across `shell.test.ts` + `tui-shell.test.ts`. Every failure is new; nothing
pre-existing regressed. Failures are the right kind: missing exports
(`drainUndelivered`, `onCompletion`, `buildTaskNotification`,
`resolveShellHoldMs`, `resolveMaxAutoWake`) and missing behaviour (no
notification in history, one provider request instead of two, zero completion
subscriptions).

Decisions on the four concerns the worker raised:

1. **Two tests pass before implementation by construction** — "wake mode does not
   hold" and "the TUI drains an operator item first" both assert an ABSENCE that
   already holds. Kept as regression guards rather than forced red; they earn
   their place once the hold and wake paths exist.
2. **Envelope attribute quoting is unpinned** by the criteria; the tests match
   `key="value"` or bare. Decision: emit QUOTED attributes, so a value that ever
   contains a space cannot silently split the envelope.
3. **AC7/AC8 are source-text audits**, because neither `runAgentRepl` (documented
   as not unit-tested) nor the OpenTUI REPL has a headless seam. Accepted with
   the same reasoning P0 used for its wiring pin: the load-bearing behaviour —
   exactly-once delivery, message shape, round-boundary placement, hold — is
   proven by EXECUTION in the other two files; the audits only pin that the two
   shells are wired to it.
4. **Widened local types + `import * as agentMod`** are how the tests reach
   not-yet-existing exports without a link-time error taking down the file. Once
   the exports exist, they may become named imports.

## Hazard: the shell audits dump whole files into the failure message

`shell.test.ts` and `tui-shell.test.ts` assert with `expect(source).toContain(…)`
over the FULL file text, so one failing audit prints the entire source into
stderr — a single run of the two files emitted over a megabyte and nearly filled
the session's context window. Never run those two files unfiltered while their
audits are red. Use `-t "<name>"` to select one, or read the count line only.
The executable tests (`agent-task-notification.test.ts`,
`background-job-registry.test.ts`) are where the real behaviour is proven; the
audits only pin that the shells are wired.

## T7/T8 note: the toolless-reprompt rail overlaps the hold test

The first hold test originally scripted the model saying "I started the build."
for the user line "build it". Both trip the PRE-EXISTING anti-narration rail:
`isActionRequest` matches the `build` token (`agent.ts:634-670`) and
`modelClaimedAction` matches the leading `I` (`:714-743`), so the turn took two
extra reprompt rounds (`MAX_TOOLLESS_REPROMPTS = 2`) and the test's
`requests.length === 2` saw 4. The hold itself was correct: it subscribed,
delivered exactly one notification, and carried the right content.

Fixed in the TEST by removing the overlap — the scripted text is now neutral
("The compilation is under way.") so the round count measures the hold rather
than the reprompt rail. The assertion stayed strict at `=== 2`; the rail's own
behaviour is unchanged and still covered by `agent.test.ts`.

## T9 result — two audit misses worth recording

Both were mine, and both were the audit catching something real about SHAPE
rather than behaviour:

1. **The race fell outside the audited window.** `shell.test.ts` slices 1 400
   characters after `const readLine = async (` and looks for `Promise.race`
   there. My first version put the subscription and its comment between the two,
   pushing the race past the window. Moved the consumer up against `readLine`
   and the subscription below it — which reads better anyway: the two line
   consumers now sit together, and the wiring follows.
2. **A computed `origin` is not a literal.** I passed
   `origin: origin === "task-notification" ? … : …`, which satisfies the type
   but never puts the string `origin: "task-notification"` in the file, so the
   TUI audit failed. Replaced with a conditional spread that carries the literal.
   The audit was right to refuse: it exists precisely to pin that a
   notification-started turn is marked, and a ternary could just as easily
   resolve to `"operator"` forever.

Also fixed on the way: I first wrote the TUI idle guard as
`mainQueue.length === 0 === false`, which parses correctly but reads as nonsense.
It is now `const idle = !busy && mainQueue.length === 0`.

**Design point worth keeping:** a notification-started turn has no operator
line, so `runAgentTurnCore` pushes the NOTIFICATION as the turn's input instead
of an empty `user` message, and returns without a model call when the drain
comes back empty — a wake that has nothing to announce must not cost a request.
The TUI reuses its single turn dispatch through `runLine(line, origin)` rather
than growing a second one.

Verification so far: typecheck clean; `agent-task-notification.test.ts` 16/16,
`background-job-registry.test.ts` 60/60, `agent.test.ts` 87/87; the readline
audits 4/4 and the TUI audits 5/5 (run with `-t` and truncated output, per the
hazard above). `keryx health run`: PASS, score 94.

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

## T10 result — green, including a live hold on a real process

Full suite (`bun test --timeout 30000`, the timeout memory prescribes):
**10 401 pass / 20 skip / 0 fail**, 67 217 expect() calls across 768 files in
695 s. Nothing pre-existing regressed; `keryx health run` PASS, score 94.

The live smoke is the part worth keeping. It drives the REAL `runAgentTurn` with
the real registry, the real `shellExecTool` (`yieldMs: 300`) and a real
`sleep 2; echo SMOKE_DONE`, in `completionDelivery: "hold"`; only the provider is
scripted, because the subject is the loop, not a model. It scripts three rounds;
pre-P1 the turn ended after round 2 with the task killed by the session sweep and
its output reported to nobody.

Result: `rounds requested: 3`, `elapsedMs: 2023`, exactly one notification,
`status="completed"`, `exit_code="0"`, `duration_ms="2016"`, body `SMOKE_DONE`,
carried as `role: user` / `provenance: tool`. The elapsed time is the proof the
hold is real — the turn sat through the full two seconds of a command that
outlived its yield, instead of finishing 300 ms in.

Smoke script kept at `scratchpad/p1-hold-smoke.ts` (session scratchpad, not
committed): it needs a 2 s wall-clock wait and a real subprocess, which is the
wrong shape for the suite, but the right shape for a one-off gate on the
behaviour the whole phase exists for.

## T11 — two real findings, both mine, both found by review

Both dispatched reviewers (code-boss-reviewer, review-regression) stalled at the
first step again: 179-byte transcripts, no output in 29 minutes, last lines "I'll
start with the project hard gate". Stopped them and reviewed the diff myself —
the fifth stall of this session and the fourth time taking the work over.

The review found ONE defect with two faces, at the text-only finish
(`agent.ts:1570-1635`). The hold block was entered only when a task was STILL
RUNNING, and the `return {}` under it drained nothing. So a task that reached a
terminal status BETWEEN the last round-boundary drain and the text-only finish
was delivered by nobody:

- **F-001 (blocker), `hold`.** A `--print` session starts a command, the model
  answers with text, the command exits while that text is being produced. The
  hold does not engage (nothing is running), the turn returns, the session exits
  and the sweep kills what is left. The command's result is reported to nobody —
  which is the exact failure the whole phase exists to prevent.
- **F-002 (major), `wake`, AC10.** A completion left undelivered must reach the
  next operator turn; both shells literally promise the operator "it will be
  reported with your next message" when the auto-wake cap is hit. A text-only
  answer has no tool batch, so the round-boundary drain never runs, and the
  promise was false.

Confirmed by EXECUTION before being written down, not by reading: a probe
driving the real loop, the real registry and real subprocesses
(`scratchpad/p1-review-probe.ts`) reported `A: rounds=2 notifications=0
undrained=1` and `B: notifications_after_turn2=0`. After the fix, `A=pass`
(3 rounds, 1 notification) and `B=pass`.

Fix: drain what is ALREADY finished first, in either mode, and only then decide
whether to hold for something still running. Three tests were added first and
seen red against the unfixed code (2 fail / 1 pass): the third is the guard that
the fix must not buy delivery with an extra round — an empty drain still ends the
turn in one request.

Why the P1 suites missed it: every hold test set up a task that was still
running, because that is the case the criteria describe. The case the criteria do
NOT describe — a task that finished a moment too early — had no test, and the
live smoke happened to use a 2 s command against a 300 ms yield, which lands in
the covered case every time.

## T12 — P1 deviations from the specification

Three, all deliberate, now recorded in specification.md §Status:

1. **Delivery mode is not one global default.** The spec reads as a single
   setting; the implementation resolves `hold` when the session is unattended and
   `wake` otherwise, because the two cases have opposite failure modes — an
   unattended `--print` run has nobody to wake, while an interactive session that
   held would freeze the prompt behind a task the operator can see for himself.
2. **No new message role.** The notification enters history as a `user` message
   with `provenance: "tool"` and a fixed banner saying the text is command output,
   not an instruction. D-10 allowed this; it is worth naming because it is the
   one place command output reaches the model wearing the operator's role, and
   the banner is the entire mitigation. The package's own gap row stays open:
   nothing in `src/harness/provider/` merges, splits or rejects consecutive
   `user` turns, so the shape is unverified against a live strict adapter.
3. **`0` means disabled, not default.** `KERYX_SHELL_HOLD_MS=0` and
   `KERYX_SHELL_MAX_AUTO_WAKE=0` switch the hold and the auto-wake off outright,
   while a malformed or negative value falls back. An operator who wants either
   mechanism gone should not have to reach for a sentinel.

M12 is marked `met (P1, audit)` rather than `met (P1)`, and that is the honest
line: the cap's resolver is proven by execution, but the multi-wake chain end to
end is not, because neither REPL has a headless seam. The same reasoning P0 used
for its wiring pin.


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
- 2026-09-16T11:02:58.166Z - task-done: T5: RED tests for AC1-AC11
- 2026-09-16T11:02:58.260Z - task-attempt: T6: started (attempt 1) — registry delivery bookkeeping, implemented by the orchestrator
- 2026-09-16T11:08:10.807Z - task-done: T6: Registry: observed, drainUndelivered, onCompletion, hold-timeout kill reason
- 2026-09-16T11:08:10.948Z - task-attempt: T7: started (attempt 1) — agent-loop delivery: message builder, round-boundary drain, resolvers
- 2026-09-16T11:09:57.755Z - task-done: T7: Agent loop: drain at the round boundary and build the notification message
- 2026-09-16T11:09:57.849Z - task-attempt: T8: started (attempt 1) — hold at the text-only finish for sessions that cannot be woken
- 2026-09-16T11:13:08.223Z - task-done: T8: Agent loop: hold the turn at the text-only finish for sessions that cannot be woken
- 2026-09-16T11:13:08.317Z - task-attempt: T9: started (attempt 1) — shells: readline race, TUI idle wake, wake cap and reset
- 2026-09-16T11:18:16.655Z - task-done: T9: Shells: readline input-vs-completion race, TUI idle wake, wake cap and reset
- 2026-09-16T11:18:17.603Z - task-attempt: T10: started (attempt 1) — verify: typecheck, P0+P1 suites, real --print hold smoke
- 2026-09-16T11:33:48.993Z - task-done: T10: Verify: typecheck, P0 regression suites, real --print hold smoke
- 2026-09-16T11:33:50.890Z - task-attempt: T11: started (attempt 1) — review round: boss-style correctness reviewer + blast-radius reviewer dispatched over the P1 diff
- 2026-09-16T11:39:42.078Z - task-done: T12: Journal deviations and mark P1 in the requirements package
- 2026-09-16T12:03:11.063Z - task-attempt: T11: blocked (attempt 2) — both dispatched reviewers (code-boss-reviewer, review-regression) stalled: 179-byte transcripts, no output in 29 minutes; stopping them and reviewing the diff myself

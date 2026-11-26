# Implementation Plan

Version: 0.1.0
Status: ready for freeze (2026-11-25)

## 1. High-Level Plan

- Objective: a Run click in Keryx Desktop is followed to its end, and the agent that proposed the
  command continues with its result.
- Scope: Tauri host (one new tab kind, one output read), keryx ACP shell profile (a prompt that
  carries run results), desktop web view (run tracking, delivery, transcript card), model guidance,
  spec update.

### Chosen approach

1. **One tab per Run.** The host opens a tab whose process is the user's shell running exactly the
   command: `<login shell> -l -i -c <command>` in the project root, with the same login environment as
   a shell tab (new host command `pty_open_command(cwd, command, title, cols, rows)`). The process exit
   is the command's exit: `panel://pty-exit {id, code}` already reports it for run tabs.
2. **The output tail comes from the host.** New host command `pty_tail(id, lines)` returns the last
   `lines` lines of the tab's ring buffer as plain text (`plain_text` + `tail_lines`, escapes removed);
   since fix round 2 it returns `{ text, truncated }`, `truncated` when the ring dropped earlier output
   (its partial first line is then left out, review LG2-002).
3. **The result starts the follow-up turn.** The desktop sends `session/prompt` to the run's own
   session with `_meta.keryx.terminalResults: [{ runId, command, state, exitCode, durationMs, output }]`
   (`state`: `exited` | `running` for a snapshot). keryx (shell profile) stores each result as a
   labelled untrusted note — nonce envelope, `redactSensitiveText`, `capResultText`, `provenance:
   "harness"`, `injected: true`, the same shape as `delegateResultNote` — stores a fixed keryx-authored
   continuation sentence as the turn's user line instead of the client's display text, and runs that
   turn with the untrusted-content floor on. One prompt carries every result that waited together.
   `initialize` (shell profile) answers `_meta.keryx.terminalResults: true`; a client talking to a
   keryx without it shows the card and sends nothing.
4. **The client waits for idle.** The server refuses a second prompt while a turn runs, so the desktop
   holds a finished result until that session's turn ends, then delivers.
5. **Replay.** A stored note replays as a user chunk with `_meta.keryx.terminalResult` (the parsed
   fields, never the envelope), and the desktop draws it as a run card, not a user bubble; the
   continuation line is not drawn as a bubble either.
6. **Model guidance.** `buildAgentSystemInstruction` gets a context flag set when the client runs
   terminals; with it the instruction says that a single-command shell block gets a Run button, the
   result comes back as an untrusted terminal-result note and the next turn starts by itself, so the
   model gives one command per block and ends its turn instead of asking for pasted output.

### Rejected alternatives

- Shell integration (OSC 133 prompt/command markers injected into zsh/bash rc) in the existing tab —
  keeps the tab's shell state and would also fix `terminal_run`, but more host work and a risk of
  clashing with user rc files (p10k etc.). Owner chose one tab per Run.
- A visible wrapper typed into the existing tab (`cmd; printf '\e]133;D;%s\a' $?`) — pollutes the
  command line and history.
- Note only, no turn (the `/delegate` behaviour) — the owner wants the agent to continue on its own.
- A separate `_keryx/terminal_result` request followed by a client `session/prompt` — two steps race
  with the user typing and can leave a note with no turn; the prompt meta is atomic.

## 2. Detailed Plan

### Wire contract (keryx ↔ desktop)

- `initialize` result, shell profile: `_meta.keryx.terminalResults: true`.
- `session/prompt` params: `_meta.keryx.terminalResults` = array of 1..8 objects:
  `runId` (string ≤ 64), `command` (string ≤ 4096), `state` (`"exited" | "running"`),
  `exitCode` (integer or `null` = ended by a signal; required when `state` is `exited`),
  `durationMs` (integer ≥ 0), `output` (string, the client sends ≤ 200 lines / 16 KiB; the server
  caps again). Any other shape → JSON-RPC invalid params, no turn, nothing stored.
- History: per result one user-role note `[terminal run <runId> result: exit <code> | still running]`,
  an `UNTRUSTED` line, `<terminal-result-<nonce>>` … `</terminal-result-<nonce>>` (output cannot forge
  or close it), then one continuation line authored by keryx.
- Replay: notes come back as user chunks with `_meta.keryx.terminalResult: { runId, command, state,
  exitCode, durationMs, output }`; the continuation line carries `_meta.keryx.terminalContinuation: true`.

### State × event matrix (one Run, desktop)

| state \ event | process exits (code / signal) | user closes the run tab | "Send output now" | session's turn running / ends | user switches the shown session | session released (idle cap) | window reload / app quit |
|---|---|---|---|---|---|---|---|
| starting (tab opening) | — | — | — | — | no change | no change | run lost, nothing sent |
| start failed | — | — | — | — | — | — | — |
| running | read tail; session idle → deliver + turn (AC3); busy → `waiting` | process killed; card "closed before it finished"; nothing sent, no turn (AC8) — except while a "Send output now" tail read is in flight: the card stays "running…" and that snapshot is still delivered once (AC8's exception, R2-FE-004) | snapshot (`state: running`) delivered + turn; card "sent while running"; the later exit is shown, not sent (AC9) — unless the process ends with its tab open before keryx accepted the snapshot's prompt (during its tail read, while it waits, or when its prompt comes back busy or "wait"): then the exit's result goes instead, once | no change | no change: the run belongs to its own session (AC3) | no change | reload: the run store (web view memory) is lost, the PTY keeps running and its tab stays in the panel, untracked, no card; app quit: the PTY closes (SIGHUP, SIGKILL after 500 ms); nothing sent either way (PC3-002) |
| waiting (finished, or a "Send output now" snapshot asked for; session busy) | a waiting snapshot (tab open) is replaced by the exit's result, one entry per run (AC9); a finished result: — | card stays; result still sent (a waiting snapshot of a still-running command too: delivered once, the exit the close causes is shown, not sent; owner 2026-11-25, F-002) | — | turn ends → waiting results of that session in ONE prompt, up to 8; the rest after that turn (AC4) | no change | kept, also when the release crosses a prompt already sent (unknown-session refusal) or keryx is shutting down; delivered once the session is held again (owner 2026-11-25, HL2-001) | lost, nothing sent (on a reload its tab stays in the panel) |
| delivered | — | no change | — | — | — | — | after `session/load` the card comes from the stored note; no new turn (AC7) |

"start failed": the host could not start the shell → error toast "Could not run the command" and a
card "could not start: <error>"; nothing sent (AC8). Two Runs in flight are independent rows; both
waiting → one prompt (AC4).

A results prompt on its way that gets no answer (the connection closed or broke under it, or a keryx
restart replaced the connection) goes back to `waiting` and is sent again once the session is held
again; keryx stores a result at most once per run id and kind (a running snapshot, a final result:
a final result after a stored snapshot is stored and gets its turn, so one session can hold two
notes for one run; nothing after a stored final result is stored) and answers an all-duplicate
prompt with `stored: 0`, which the desktop counts as delivered (review R2-HL-002, R3-LG-006). The all-duplicate prompt starts no turn, except when
one of its runs or more has a note among the stored notes that end the history (their turn was
never recorded: keryx stopped before it ended, and it may have run in part, R4-HL-001): then it
runs the follow-up turn on the notes that end the history, a full turn under the floor, storing
nothing again, and answers `resumed: true` beside `stored: 0` (R3-LG-005, R4-AR-002; the no-turn
answer has no `resumed` key, and the desktop reads neither). A duplicate whose note sits further
up had its turn recorded and does not stop that turn (R5-LG-002). A resend that carries new
results beside a duplicate whose run has a note among those that end the history runs one turn on
those notes and the new ones, and `/rewind` of it takes them all out (R4-LG-003, R5-LG-002). A
turn keryx's own stop cancelled after it was persisted with keryx's continuation line is not
re-run. A snapshot prompt that got no answer
may have been stored: the exit's result that replaces it is then stored as a second note. A
session reload inside the window (`/compact`, `/rewind`, a released session, a keryx restart)
keeps a live card only where its note is replayed (the newest note's place when keryx replays
two for one run) or its run can still change and is not "not sent" (`keptOnReload`: not final,
or its tab open); any other final card is dropped (reviews R2-UX-001, R3-FE-001). A card in a
replayed note's place stays there only when the run next sends a result of that note's kind (a
duplicate); the exit after a replayed snapshot moves it to the end, and the agent's reply follows
it (R4-LG-002). The run store forgets a run only when its state is final and its tab is closed
(`runCanChange`), so a "not sent" run keeps a working Show tab while its tab is open (R4-RR-001).
A byte cut that keeps no whole line sends the cut line and `[the last line is longer than 16 KiB
and was not sent]` (R3-UX-001).

### Tasks (see tasks.md for ids)

- T5 host: `pty_open_command`, `pty_tail`, invoke registration, TS wrappers in `platform/panels.ts`,
  Rust tests.
- T6 keryx: `src/acp/terminal-result.ts` (validate, note, parse), server wiring in `src/acp/server.ts`
  (prompt meta → notes + continuation line + floor; replay meta; `initialize` meta), system-instruction
  flag in `src/commands/agent.ts`, tests in `src/acp/`.
- T7 desktop: run store per window keyed by runId and session; `runInTerminal` carries the session id
  and source (message block / tool card); `TerminalPanel` opens the run tab with `pty_open_command`;
  exit → `ptyTail` → result; delivery queue per session waiting for idle; transcript run card (running,
  waiting, sent, exit code, output, closed, could not start) and replay rendering; dom tests.
- T8 docs: spec §4.4 (D-13) and the wire contract next to §3.9.5a.
- T9 verify: a live run in the installed desktop app, judged by the owner.

## 3. Execution Tracking

- [ ] T5 host commands
- [ ] T6 keryx prompt meta, notes, floor, replay, guidance
- [ ] T7 desktop run tracking, delivery, card
- [ ] T8 spec
- [ ] T9 live check
- [ ] Phase 3: focused tests, code-verifier, health, review

## Risks

- `-l -i -c` may print rc noise or hang on an rc that reads the terminal; mitigated by the PTY (rc
  sees a tty) and by "Send output now" / closing the tab.
- A dev server never exits: the user decides with "Send output now"; no timeout in this flow.
- The follow-up turn reads untrusted output: floor on, envelope, redaction (AC5, AC6).
- Desktop CI noise from memory (`searchable-sources`, flaky `shellenv` Rust test): rerun before
  treating as a regression.

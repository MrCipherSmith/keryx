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
   `lines` lines of the tab's ring buffer as plain text (`plain_text` + `tail_lines`, escapes removed).
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
| running | read tail; session idle → deliver + turn (AC3); busy → `waiting` | process killed; card "closed before it finished"; nothing sent, no turn (AC8) | snapshot (`state: running`) delivered + turn; card "sent while running"; the later exit is shown, not sent (AC9) | no change | no change: the run belongs to its own session (AC3) | no change | process dies with the window (existing PTY close); nothing sent |
| waiting (finished, or a "Send output now" snapshot asked for; session busy) | — | card stays; result still sent (a waiting snapshot of a still-running command too: delivered once, the exit the close causes is shown, not sent; owner 2026-11-25, F-002) | — | turn ends → waiting results of that session in ONE prompt, up to 8; the rest after that turn (AC4) | no change | kept, also when the release crosses a prompt already sent (unknown-session refusal) or keryx is shutting down; delivered once the session is held again (owner 2026-11-25, HL2-001) | lost, nothing sent |
| delivered | — | no change | — | — | — | — | after `session/load` the card comes from the stored note; no new turn (AC7) |

"start failed": the host could not start the shell → error toast "Could not run the command" and a
card "could not start: <error>"; nothing sent (AC8). Two Runs in flight are independent rows; both
waiting → one prompt (AC4).

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

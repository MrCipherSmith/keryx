# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

`cargo` is not on the agent shell's PATH on this machine; it is `/opt/homebrew/opt/rustup/bin/cargo`
(the login shell has it). Desktop tests run from the repository root with `bun --cwd apps/desktop test`.

## Criteria

- AC1: Run on a single-command shell block in a message and Run on an executed `execute` tool card both open a new terminal tab whose process is the user's login shell running exactly that command (`pty_open_command`); the previously active tab receives no input. [verify: exec `bun --cwd apps/desktop test src/panels/RunButton`]
- AC2: The host command `pty_open_command(cwd, command, title, cols, rows)` runs `<login shell> -l -i -c <command>` in the project root with a shell tab's login environment, the command's exit code arrives as `panel://pty-exit {id, code}`, and `pty_tail(id, lines)` returns the last `lines` lines of the tab's output as plain text with escape sequences removed. [verify: exec `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml run_command`]
- AC3: When the run's process exits, the session that showed the Run button — also while another session is shown — receives exactly one `session/prompt` whose `_meta.keryx.terminalResults` carries that run's `runId`, `command`, `state: "exited"`, `exitCode`, `durationMs` and at most 200 lines / 16 KiB of plain-text output, and a follow-up agent turn starts with no user input. [verify: exec `bun --cwd apps/desktop test src/session/terminalRun`]
- AC4: A result whose process ends while that session's turn is running waits and is delivered when the turn ends; results that waited together are delivered in one `session/prompt` (one follow-up turn). [verify: exec `bun --cwd apps/desktop test src/session/terminalRun`]
- AC5: keryx (shell profile) stores each `terminalResults` entry as a labelled untrusted user-role note with `provenance: "harness"` — nonce envelope, `redactSensitiveText`, `capResultText` — and stores its own continuation sentence as the turn's user line instead of the client's text; an output that contains a forged closing tag cannot end the envelope, and malformed meta (wrong types, more than 8 entries, `exitCode` missing on `exited`) is refused as JSON-RPC invalid params with nothing stored and no turn run. [verify: exec `bun test src/acp/terminal-result` · sensitive: failure-scenario]
- AC6: The follow-up turn started by a `terminalResults` prompt runs under the untrusted-content floor: a tool call that the session's permission mode would otherwise auto-approve is sent as a permission request instead. [verify: exec `bun test src/acp/terminal-result` · sensitive: failure-scenario]
- AC7: After `session/load`, keryx replays each stored note as a user chunk with `_meta.keryx.terminalResult` (the parsed fields, never the envelope) and the continuation line with `_meta.keryx.terminalContinuation: true`; the desktop draws the note as a run card (command, exit code, output) and draws no user bubble for the continuation line; no turn starts. [verify: exec `bun test src/acp/terminal-result && bun --cwd apps/desktop test src/session/terminalRun`]
- AC8: Failure paths send nothing to the agent and start no turn: closing the run tab before the command ends kills it and the card says it was closed before it finished; a shell that cannot start shows the "Could not run the command" toast and a card naming the error; a keryx whose `initialize` lacks `_meta.keryx.terminalResults` gets no prompt and the card says the result was not sent. [verify: exec `bun --cwd apps/desktop test src/session/terminalRun src/panels/RunButton` · sensitive: failure-scenario]
- AC9: "Send output now" on a running run delivers one snapshot (`state: "running"`, no `exitCode`) and starts a follow-up turn; the run's later exit updates the card and is not delivered again. [verify: exec `bun --cwd apps/desktop test src/session/terminalRun`]
- AC10: For a client that advertised `_meta.keryx.terminal: true`, the system instruction says that a single-command shell block gets a Run button, that the command's exit code and output return as an untrusted terminal-result note and the next turn starts by itself, and that the model should end its turn rather than ask the user to paste output; for any other client the sentence is absent. [verify: exec `bun test src/acp/terminal-result`]
- AC11: Root typecheck and lint, and the desktop build (its `tsc --noEmit` and `vite build`), pass on the final head. [verify: exec `bun run typecheck && bun run lint && bun --cwd apps/desktop run build`]
- AC12: The desktop specification documents the run tab (`pty_open_command`, `pty_tail`), the `initialize` and `session/prompt` meta, the note and replay meta, and the waiting rule. [verify: invariant `grep -q "terminalResults" docs/requirements/keryx-desktop-client/specification.md && grep -q "pty_open_command" docs/requirements/keryx-desktop-client/specification.md`]
- AC13: In the installed desktop app the agent proposes a command in a shell block, the owner clicks Run, the command runs in its own tab, and the agent continues with the command's exit code and output without being asked. [verify: judged]

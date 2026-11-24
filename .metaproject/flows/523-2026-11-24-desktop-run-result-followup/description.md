# Desktop Run button: the agent follows the command it asked the user to run

Status: formalized (flow-orchestrator Phase 1, 2026-11-25)
Source: owner request in a desktop session (origin `human-request`)

## Problem

In Keryx Desktop a single-command shell block in the agent's reply, and the
command of an executed `execute` tool card, get a **Run** button (D-13). The
button types the command and Enter into the active terminal tab
(`apps/desktop/src/panels/TerminalPanel.tsx:81-96`, `ptyWrite(t.id, "${command}\r")`)
and forgets it: nothing records when the command ends, with which exit code,
or what it printed, and nothing reaches the session. The agent asked for the
command because it needs the result, yet it never learns the result unless the
user copies the output back by hand.

## Expected Outcome

- Run starts the command in its **own terminal tab** (the user's shell running
  exactly that command), so its end and exit code are known exactly.
- When the command ends, the session that showed the button receives the
  result — command, exit code, duration, the tail of the plain-text output — and
  the **agent continues on its own** in a follow-up turn, without the user
  typing anything.
- The output reaches the model as labelled untrusted content (as `/delegate`
  results do), never as the operator's words.
- The transcript shows the run as a card (running, then exit code and output),
  also after the session is reloaded.
- The model is told that the Run button exists and that the result comes back,
  so it ends its turn after proposing a command instead of asking the user to
  paste output.

## Outcome criteria

- not measured — the owner checks the behaviour in a live desktop session (AC
  judged); no usage metric exists for Run clicks.

## Out of Scope

- Shell integration (OSC 133 markers) in ordinary shell tabs, and making the
  agent's own `terminal_run` panel tool report an exit code — rejected for this
  flow by the owner in favour of one tab per Run.
- Running a Run command in an existing tab's shell state (its `cd`/`export`).
- A per-session or global switch to turn the automatic follow-up off.
- The TUI and the readline shell (they have no Run button).
- Multi-line shell blocks (they still get no Run button).

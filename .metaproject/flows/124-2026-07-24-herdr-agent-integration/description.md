# herdr agent-state integration for keryx shell: report working/idle/blocked to herdr via pane socket

Status: formalized
Source: user description

## Problem

`keryx shell` runs as an interactive OpenTUI shell inside a `herdr` pane, but
herdr shows it as a plain pane with no agent status — unlike `claude`
(screen-detected) and `opencode` (plugin-reported), which surface
working/idle/blocked in herdr's agent panel. keryx should report its lifecycle
state the same way so a herdr workspace can track keryx panes alongside other
agents.

## Expected Outcome

When `keryx shell` (OpenTUI agent shell) runs in a herdr pane, herdr's agent
list shows agent `keryx` with a live status:

- **working** while a turn streams / a tool runs;
- **blocked** while an approval or `ask_user` prompt is pending;
- **idle** at the prompt between turns;
- the pane is **released** back to herdr on shell exit.

Reporting is best-effort and optional: a no-op when not launched inside herdr
(env `HERDR_ENV=1` + `HERDR_PANE_ID` + `HERDR_SOCKET_PATH` absent). No new
runtime dependencies (`node:net` only). No behavior change to the shell itself.

## Out of Scope

- The readline `runShell` (`--no-tui`) path — TUI is the default and the target;
  wiring the readline spinner is a follow-up.
- `pane.report_agent_session` session-identity reporting (state alone is enough
  for status display) — follow-up.
- Any change to herdr — it already ships a `keryx` detection manifest and
  accepts the `keryx` agent id (verified live).

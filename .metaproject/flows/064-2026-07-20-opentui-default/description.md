# Flow 064 — OpenTUI default on TTY (Phase 5, conservative)

Phase 5 of docs/requirements/keryx-opentui-shell. Flips the default so agent mode
on an interactive TTY launches the OpenTUI shell, with a `--no-tui` opt-out and
the readline shell RETAINED as the guaranteed fallback (retiring readline is
deferred until a real-world sign-off, per the PRD). Adds a clean stdin handoff
(close readline once the renderer inits). Reversible: one flag / one condition.

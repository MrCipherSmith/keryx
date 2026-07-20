# Flow 066 — OpenTUI stdin handoff fix

Follow-up to the flow-065 revert. The corruption on a real TTY was the readline
interface consuming the terminal's responses to OpenTUI's capability queries
(sent inside createCliRenderer) because readline was still attached. Fix: release
readline BEFORE createCliRenderer (onBeforeInit), after the dep/TTY guards so the
fallback paths keep readline. TUI stays opt-in via --tui; user validates on a real
terminal.

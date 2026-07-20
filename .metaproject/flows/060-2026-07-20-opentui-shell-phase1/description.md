# Flow 060 — OpenTUI shell Phase 1

Phase 1 of docs/requirements/keryx-opentui-shell, following the flow-059 spike
(verdict GO). Ratifies the dependency surface (ADR-0005 + AC15 update), promotes
the spike into a `TuiShell` renderer skeleton that implements `AgentIO` and drives
`runAgentTurn` from a split-footer composer (plain text only), keeps the readline
shell as the guaranteed fallback, and proves the driver→TUI render path with a
headless test. Markdown/tool-collapse/reasoning chrome parity is Phase 2.

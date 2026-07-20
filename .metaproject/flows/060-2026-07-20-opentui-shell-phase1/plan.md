# Plan — flow 060
- T1 context: spike outcome, AC15/guard files, ADR format, AgentIO surface, driver hooks. [done]
- T2 ADR + ratify: ADR-0005; @opentui/core → optionalDependencies; update AC15 pin + rationale.
- T3 TuiShell: implement AgentIO→transcript (plain text) + launchTuiAgentShell(split-footer) driving runAgentTurn; --tui wiring + fallback.
- T4 test + verify: headless driver→render test (scripted provider); tsc; bun test >= baseline; non-TTY fallback smoke.

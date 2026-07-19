# Plan — flow 050

- T1 (context): confirm AgentIO/driver hook points, usage_update shape, ui.ts helpers, ui.test invariants. [done in orchestrator investigation]
- T2 (implement): AgentIO.onAssistantText + onUsage; driver wires both. `summarizeToolArgs` in ui.ts. runAgentRepl: buffer+render markdown, styled header/separator, usage line, tool-arg styling.
- T3 (test): unit tests — summarizeToolArgs (color/plain/malformed); driver calls onAssistantText once per round with full text; driver forwards onUsage on usage_update.
- T4 (verify): tsc clean; bun test ≥ baseline; manual openrouter smoke = user.

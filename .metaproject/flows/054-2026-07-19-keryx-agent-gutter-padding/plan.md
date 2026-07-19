# Plan — flow 054
- T1 context: gutter sites in createRichIo (header/prompt) + runAgentRepl (all agent chrome + live/fallback render). [done]
- T2 implement: indentBlock in ui.ts; PAD gutter across header/prompt + agent-mode sites; render funcs indent.
- T3 test: indentBlock unit tests (non-empty prefixed, empty untouched, multiline).
- T4 verify: tsc; bun test >= baseline; NO_COLOR plain-path; cli smoke.

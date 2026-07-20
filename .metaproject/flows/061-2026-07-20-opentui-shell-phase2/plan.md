# Plan — flow 061
- T1 context: OpenTUI styling API (t/chunks/StyledText), MarkdownRenderable worker limitation, AgentIO hooks. [done]
- T2 implement: markdownToChunks (worker-free) + StyledText assistant body; styled role/tool/collapse/reasoning/usage/system in createTuiAgentIo; ● keryx header in launchTuiAgentShell.
- T3 test: headless markdown + tool render assertions.
- T4 verify: tsc; bun test >= baseline.

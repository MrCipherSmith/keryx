# Plan — flow 051
- T1 context: confirm Pi technique + flow-050 wiring points, sync-output escapes, flow-048 constraints. [done in orchestrator research]
- T2 implement core: src/lib/live-render.ts (stripAnsi, displayWidth, physicalRows, computeRepaint, LiveMarkdownBlock).
- T3 implement wiring: runAgentRepl uses LiveMarkdownBlock (TTY+color gate; flow-050 fallback; ~50ms coalesced flush; per-round block lifecycle).
- T4 test: live-render.test.ts (pure fns + LiveMarkdownBlock via injected out).
- T5 verify: tsc clean; bun test >= baseline; cli smoke; live openrouter smoke = user.

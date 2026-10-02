# Flow Journal

- 2026-10-02T06:02:04.112Z - flow created
- 2026-10-02T06:07:05.603Z - task-added: T5: Codex prompt_cache_key = session id + live probe (AC8)
- 2026-10-02T06:07:09.973Z - task-added: T6: Codex context window from /models + overflow compact-and-retry (AC1, AC2)
- 2026-10-02T06:07:10.730Z - task-added: T7: Usage-anchored request estimate incl. reasoning bytes (AC3)
- 2026-10-02T06:07:11.484Z - task-added: T8: Operator-turn accounting + merged summary in compaction (AC5)
- 2026-10-02T06:07:12.257Z - task-added: T9: Single Anchors block with delta updates (AC4)
- 2026-10-02T06:07:13.013Z - task-added: T10: Spill large tool output to session file (AC7)
- 2026-10-02T06:07:13.803Z - task-added: T11: Prune old tool outputs behind protected window, prune before compact (AC6)
- 2026-10-02T06:07:14.561Z - task-added: T12: Synthetic session-shape replay fixture and before/after numbers (AC9)
- 2026-10-02T06:07:15.422Z - task-added: T13: Comparative benchmark: cached/uncached tokens + success rate vs codex CLI and opencode (AC10, AC11)
- 2026-10-02T06:07:21.143Z - task-done: T1: Collect remaining context
- 2026-10-02T06:07:21.934Z - task-done: T2: Implement per plan
- 2026-10-02T06:14:21.698Z - frozen: 11 criteria; checksum recorded
- 2026-10-02T06:14:26.415Z - started
- 2026-10-02T06:35:28.643Z - task-attempt: T5: started (attempt 1) — 387-T5
- 2026-10-02T06:35:29.740Z - task-attempt: T6: started (attempt 1) — 387-T6
- 2026-10-02T06:45:05.193Z - task-done: T6: Codex context window from /models + overflow compact-and-retry (AC1, AC2)

## 2026-10-02 — live probe (AC1, AC8), orchestrator

Ran against `https://chatgpt.com/backend-api/codex` through this branch's `makeProvider("openai-codex")`, model `gpt-6.1-sol`, two identical ~2.4K-token requests per run:

- AC1: `loadSessionLimits({ provider: "openai-codex", model: "gpt-6.1-sol" })` → `{"contextWindow":272000,"contextSource":"live-models"}`.
- AC8: the endpoint accepts `prompt_cache_key` (HTTP 200, normal stream).
- Cache effect (`usage.cacheReadTokens` of round 2):
  - `prompt_cache_key` only → 0 (two runs).
  - plus headers `session-id` + `thread-id` = same id (as codex CLI's `build_session_headers`) → 2304 of 2426.
  - headers only, no `prompt_cache_key` → 2304 of 2426.
- Conclusion: on the Codex backend the `session-id` header is what enables prefix caching; the body key alone does not. T5 follow-up dispatched to add both headers on the Codex branch.

T6 done: commits 7abf9584 + ef3b8248 (agent.ts shared with T5). T5: ef3b8248, header follow-up open.
- 2026-10-02T06:45:33.840Z - task-attempt: T7: started (attempt 1) — 387-T7
- 2026-10-02T06:45:37.452Z - task-attempt: T10: started (attempt 1) — 387-T10
- 2026-10-02T06:48:30.683Z - task-done: T5: Codex prompt_cache_key = session id + live probe (AC8)

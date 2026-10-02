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
- 2026-10-02T06:56:51.203Z - task-added: T14: Let read_file/search_code read the current session's tool-output spill dir (read-only) so spilled output is recoverable
- 2026-10-02T06:56:52.500Z - task-done: T7: Usage-anchored request estimate incl. reasoning bytes (AC3)
- 2026-10-02T06:56:53.517Z - task-done: T10: Spill large tool output to session file (AC7)
- 2026-10-02T06:57:35.134Z - task-attempt: T8: started (attempt 1) — 387-T8T9 combined dispatch
- 2026-10-02T06:57:36.997Z - task-attempt: T9: started (attempt 1) — 387-T8T9 combined dispatch
- 2026-10-02T06:57:38.316Z - task-attempt: T14: started (attempt 1) — 387-T14
- 2026-10-02T07:03:57.049Z - task-done: T14: Let read_file/search_code read the current session's tool-output spill dir (read-only) so spilled output is recoverable
- 2026-10-02T07:04:00.356Z - task-added: T15: Anthropic: cache_control breakpoints on the stable prefix + count cache_read/cache_creation in inputTokens
- 2026-10-02T07:04:10.573Z - task-attempt: T15: started (attempt 1) — 387-T15
- 2026-10-02T07:05:51.379Z - task-done: T8: Operator-turn accounting + merged summary in compaction (AC5)
- 2026-10-02T07:05:53.222Z - task-done: T9: Single Anchors block with delta updates (AC4)
- 2026-10-02T07:06:02.842Z - task-attempt: T11: started (attempt 1) — 387-T11
- 2026-10-02T07:08:55.265Z - task-done: T15: Anthropic: cache_control breakpoints on the stable prefix + count cache_read/cache_creation in inputTokens
- 2026-10-02T07:09:08.175Z - task-added: T16: Anthropic cache-read/write discount in estimateTaskCostUsd (cost display overestimates after T15)
- 2026-10-02T07:09:09.155Z - task-attempt: T13: started (attempt 1) — 387-T13a benchmark instrumentation only (live runs after T12)
- 2026-10-02T07:14:11.477Z - task-done: T11: Prune old tool outputs behind protected window, prune before compact (AC6)
- 2026-10-02T07:16:11.080Z - ac-updated: AC6: "Before each request, tool results outside a protected window (the newest 40K estimated tokens of tool output and the last 2 operator turns) are replaced in the outgoing request by a fixed placeholder naming the spill file, only when that saves at least 20K estimated tokens; `archive.jsonl` keeps the original text. Pruning runs before compaction, and compaction runs only if the request is still over threshold after pruning. Tests cover the threshold, the protected window and the archive content." -> "Before each request, tool results outside a protected window (the newest 40K estimated tokens of tool output, plus the operator message that started the current turn) are replaced in the outgoing request by a fixed placeholder naming a readable file with the full text, only when that saves at least 20K estimated tokens; archive.jsonl keeps the original text. Pruning acts inside a long single operator turn too. Pruning runs before compaction, and compaction runs only if the request is still over threshold after pruning. Tests cover the threshold, the protected window, a one-operator-turn session and the archive content." (Owner decision 2026-10-02: protecting the whole last 2 operator turns disables pruning in few-turn sessions (the motivating 2026-10-01 shape), leaving only the lossier in-turn compaction; protect the newest 40K tokens + the turn's operator message instead. No confirmations existed.)
- 2026-10-02T07:16:39.364Z - task-added: T17: Prune inside a long single operator turn per re-frozen AC6 (protect newest 40K + the turn's operator message); wire prune into wrap-up compaction sites
- 2026-10-02T07:17:04.069Z - task-attempt: T17: started (attempt 1) — 387-T17 via T11 worker
- 2026-10-02T07:19:28.669Z - task-attempt: T13: blocked (attempt 2) — instrumentation landed; live comparative runs wait for T17 + T12
- 2026-10-02T07:19:39.281Z - task-attempt: T12: started (attempt 1) — 387-T12
- 2026-10-02T07:19:40.493Z - task-attempt: T16: started (attempt 1) — 387-T16
- 2026-10-02T07:20:50.136Z - task-done: T17: Prune inside a long single operator turn per re-frozen AC6 (protect newest 40K + the turn's operator message); wire prune into wrap-up compaction sites
- 2026-10-02T07:23:07.344Z - task-done: T16: Anthropic cache-read/write discount in estimateTaskCostUsd (cost display overestimates after T15)
- 2026-10-02T07:28:39.796Z - task-added: T18: Collapse old tool exchanges (call args + reasoning + result) into one-line text records outside the protected window; live-probe Codex accepts it; rerun T12 replay
- 2026-10-02T07:28:40.793Z - task-attempt: T18: started (attempt 1) — 387-T18 via T11 worker

## 2026-10-02 — owner decisions and T12 first measurement

- AC6 re-frozen (owner, via question): protecting the whole last 2 operator turns disabled pruning in few-turn sessions; protected window is now the newest 40K tokens of tool output only. Implemented in T17 (ecbb4db5).
- T12 replay (seed 0x20261001, openai-codex/gpt-6.1-sol, window 272000, threshold 231200), at ecbb4db5:
  - main-before: peak 241577 (88.8% of window), total 14,848,882 over 110 requests, 0 compactions.
  - branch: peak 140469 (51.6%), total 9,832,311 — **−33.8%**, 4 prune rounds (87 results cleared), 0 compactions, 0 spills.
  - AC9 peak clause met; the ≥ 50% total clause **not met**. Fixture not tuned.
  - Remaining per-request floor: replayed reasoning ~36K tokens, old tool-call arguments ~25K, system + tool schemas ~9.5K, protected 40K window.
- Owner decision: reach 50% rather than lower AC9, and — owner's idea — stop re-sending old tool exchanges as structured function calls: collapse each old call group (args + reasoning + result) into one-line text records naming the saved output. T18 dispatched; Codex acceptance is live-probed before it lands.
- 2026-10-02T07:40:55.809Z - task-done: T18: Collapse old tool exchanges (call args + reasoning + result) into one-line text records outside the protected window; live-probe Codex accepts it; rerun T12 replay
- 2026-10-02T07:41:46.736Z - task-added: T19: Keep encrypted reasoning replay only on the last 3 assistant rounds (inside the protected window too); live-probe a structured call without its reasoning on Codex; rerun T12 replay
- 2026-10-02T07:41:47.571Z - task-attempt: T19: started (attempt 1) — 387-T19 via T11 worker
- 2026-10-02T07:47:23.665Z - task-done: T19: Keep encrypted reasoning replay only on the last 3 assistant rounds (inside the protected window too); live-probe a structured call without its reasoning on Codex; rerun T12 replay
- 2026-10-02T07:47:24.504Z - task-done: T12: Synthetic session-shape replay fixture and before/after numbers (AC9)
- 2026-10-02T07:48:31.641Z - task-attempt: T13: started (attempt 3) — 387-T13b live comparative runs
- 2026-10-02T08:02:49.138Z - task-added: T20: Fix core-package boundary: compact.ts/prune.ts/output-spill.ts leaked into the src/core.ts module graph (CI core-package.test.ts)
- 2026-10-02T08:02:50.110Z - task-attempt: T20: started (attempt 1) — 387-T20
- 2026-10-02T08:08:04.058Z - task-done: T20: Fix core-package boundary: compact.ts/prune.ts/output-spill.ts leaked into the src/core.ts module graph (CI core-package.test.ts)
- 2026-10-02T08:33:30.578Z - task-added: T21: Review round 1 fixes (2026-10-02-ingest-849): F-001..F-013
- 2026-10-02T08:33:46.224Z - task-attempt: T21: started (attempt 1) — 387-T21 A (hosts/loop) + B (prune/spill) in worktree flow-387-r1
- 2026-10-02T09:29:30.132Z - task-added: T22: Long-session quality check: 1-2 benchmark tasks long enough to trigger prune/collapse/compaction; branch vs main success + repeated reads + tokens
- 2026-10-02T09:29:31.035Z - task-attempt: T22: started (attempt 1) — 387-T22a design long tasks (no live runs)
- 2026-10-02T10:10:14.184Z - task-done: T21: Review round 1 fixes (2026-10-02-ingest-849): F-001..F-013
- 2026-10-02T10:10:26.916Z - task-attempt: T22: started (attempt 2) — 387-T22b live long runs: registry-recall, branch vs main, 1 seed
- 2026-10-02T10:27:34.217Z - task-added: T23: Review round 2 fixes (2026-10-02-ingest-849-r02): F-021 ACP archive cursor + load seeding, F-022..F-029
- 2026-10-02T10:27:35.139Z - task-attempt: T23: started (attempt 1) — 387-T23 round 2 fixes
- 2026-10-02T10:31:32.309Z - ac-updated: AC10: "The mutating-ablation benchmark records uncached input, cached input and output tokens per task for keryx shell, codex CLI and opencode, and a committed comparative report runs all three on the same task set (model per leg stated, any mismatch disclosed). In that report keryx shell has the lowest mean uncached input tokens per task, or is within 5% of the lowest." -> "The mutating-ablation benchmark records uncached input, cached input and output tokens per task for keryx shell and codex CLI on the same model (gpt-6.1-sol via the ChatGPT subscription), and a committed comparative report runs both on the same task set; in it keryx shell has the lowest mean uncached input tokens per task, or is within 5% of the lowest. opencode is run on a free OpenCode Zen model and reported separately as a different-model reference, not part of the verdict." (Owner decision 2026-10-02: opencode cannot run gpt-6.1-sol (Zen balance empty; its own OpenAI OAuth expired) and Zen's free models are served only to the opencode client (keryx gets HTTP 403), so no same-model keryx/opencode pair exists; verdict on the same-model codex CLI pair, opencode as a disclosed reference. No confirmations existed.)
- 2026-10-02T10:47:02.748Z - task-done: T23: Review round 2 fixes (2026-10-02-ingest-849-r02): F-021 ACP archive cursor + load seeding, F-022..F-029
- 2026-10-02T10:58:16.596Z - task-added: T24: Repeat-guard: a re-read of a file whose earlier result was pruned/collapsed/compacted must not count against MAX_ATTEMPTS_PER_HASH
- 2026-10-02T10:58:17.474Z - task-attempt: T24: started (attempt 1) — 387-T24
- 2026-10-02T11:05:25.696Z - task-done: T24: Repeat-guard: a re-read of a file whose earlier result was pruned/collapsed/compacted must not count against MAX_ATTEMPTS_PER_HASH
- 2026-10-02T11:05:43.113Z - task-attempt: T22: started (attempt 3) — 387-T22d branch vs main long run at 128K after T24
- 2026-10-02T11:28:02.733Z - task-added: T25: Review round 3 fixes (2026-10-02-ingest-849-r03): F-032 wiring audit inventory, F-033 bounded repeat-guard reset, F-024 enforce pruneArchive contract, F-029 test helpers
- 2026-10-02T11:28:53.134Z - task-attempt: T25: started (attempt 1) — 387-T25 in worktree flow-387-r3

## 2026-10-02 — benchmark results and the quality decision (owner)

- AC10 (same model gpt-6.1-sol, 3 tasks × 2 variants × 3 seeds): keryx 12,628 input per task (context-on), codex CLI 35,199 uncached + 139,079 cached; success 100% both. opencode reference on opencode/nemotron-3-ultra-free: ~160K uncached + ~45K cached, 18/18.
- AC11 on the short benchmark: success 100% vs main 100% (context-on); repeated reads 0 vs 0. The short tasks never trigger prune, so this shows no regression only.
- Long-session check (`long-session-report.md`, registry-recall, 128K, 1 seed): both 0/22. main stops after 10/22 files (50 requests); the branch reads all 22 but re-reads after each prune (96 repeats) until the 150-call cap — similar uncached input, ~5× total tokens. Root cause: the model keeps no notes across prune.
- Owner decision: close 387 with AC11 confirmed on the short benchmark and the long-session result recorded as a known limitation; the re-read loop and note-taking move to flow 388 (slate as working memory), with registry-recall as its main test. T25's bounded repeat-guard reset (F-033) caps the loop's cost meanwhile.
- Product findings for 388: builtin tools cap output (shell_exec 20 KB, read_file 20K chars) below the 50 KB spill threshold, so spill only fires for uncapped (MCP) tools.
- 2026-10-02T11:53:18.615Z - task-done: T25: Review round 3 fixes (2026-10-02-ingest-849-r03): F-032 wiring audit inventory, F-033 bounded repeat-guard reset, F-024 enforce pruneArchive contract, F-029 test helpers
- 2026-10-02T11:53:20.093Z - task-done: T22: Long-session quality check: 1-2 benchmark tasks long enough to trigger prune/collapse/compaction; branch vs main success + repeated reads + tokens
- 2026-10-02T11:53:21.438Z - task-done: T13: Comparative benchmark: cached/uncached tokens + success rate vs codex CLI and opencode (AC10, AC11)

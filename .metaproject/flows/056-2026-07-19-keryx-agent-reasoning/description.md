# Flow 056 — agent reasoning/thinking section

## Problem
Reasoning-capable models (via OpenRouter: deepseek-r1, o1, qwen-thinking, etc.)
stream their chain-of-thought in a separate `delta.reasoning` field, which keryx
currently drops (the normalized layer has no reasoning event). OpenCode/claude
show a distinct, de-emphasized "thinking" section above the answer. Add it.

## Approach
- Add `reasoning_delta` to NormalizedEventKind (no exhaustive switch consumes the
  union, so this is additive/safe).
- OpenAI-compat adapter: parse `delta.reasoning` / `delta.reasoning_content` →
  `reasoning_delta` (reusing the `text` field). Non-reasoning chunks unchanged.
- Driver: accumulate reasoning; new optional onReasoning(text) hook fired once
  per round before the answer (at first text_delta, or round end if reasoning-only).
- REPL: dim, gutter-indented `⋯ thinking` section before the answer; nothing when
  there is no reasoning (gpt-4o-mini path unchanged).

## Out of scope
Inline `<think>…</think>` tag parsing (a separate content-splitting concern),
persisting reasoning in history, collapsible reasoning (it is already dim).

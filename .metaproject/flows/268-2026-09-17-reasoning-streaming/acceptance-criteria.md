# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The OpenAI-compatible and OpenAI Responses adapters read `response.body` incrementally and yield each parsed event before the body ends; a test stream that sends a text chunk and then stays open observes that chunk's `text_delta` before the stream closes, and a stream that sends `[DONE]` (compat) or `response.completed` (Responses) without closing yields `model_end` and ends the turn.
- AC2: A stream that sends no byte within the first-byte timeout, or no chunk within the idle timeout, ends with exactly one retryable `provider_error` of kind `unavailable` and no `model_end`; both timeouts are configurable; aborting mid-stream still yields exactly one `cancelled` error and no `model_end` (tests for both adapters).
- AC3: The compat payload carries `max_tokens` and the Responses payload carries `max_output_tokens`, each equal to `request.budget.maxOutputTokens` (payload assertion tests).
- AC4: A custom compat provider accepts `reasoning: { format: "field" | "inline-tags" | "split", requestParams?, replay? }` in `llm-providers.json`, validated on load; with `format: "inline-tags"`, content `<think>A</think>B` yields `reasoning_delta` "A" and `text_delta` "B", including when a tag is split across SSE chunks, an unclosed `<think>` at finish yields reasoning only, and a stray `</think>` is dropped; without that format, content is passed through unchanged.
- AC5: With `requestParams` set, those keys are merged into the compat request payload; `reasoning_content`, `reasoning` and MiniMax `reasoning_details` deltas are emitted as `reasoning_delta`.
- AC6: `NormalizedMessage` carries optional reasoning (text, redacted flag, provider replay items); `runAgentTurn` stores it on the assistant message including tool-call-only rounds; the session store writes and reads it back so a save/resume round-trip preserves it; compaction keeps it on retained messages.
- AC7: Compat replay: `replay: "deepseek"` sends `reasoning_content` on prior assistant messages when the request has tools; `replay: "minimax"` sends `reasoning_details` (split) or the original `<think>` content (inline-tags); no replay setting sends no reasoning (payload tests).
- AC8: Anthropic adapter: when reasoning effort is set, the request includes `thinking`; `thinking_delta` yields `reasoning_delta`; `thinking` blocks with `signature` and `redacted_thinking` blocks are captured and replayed unchanged before `tool_use` in the next request of the tool loop; its `reasoningMetadata` capability is true.
- AC9: OpenAI Responses adapter: when reasoning effort is set, the request includes `reasoning: { effort, summary: "auto" }` and `include: ["reasoning.encrypted_content"]`; reasoning items with encrypted content are captured and replayed in the next request's input.
- AC10: Gemini adapter: when reasoning effort is set, `generationConfig.thinkingConfig.includeThoughts` is true; a `thoughtSignature` on any response part is captured and sent back on the same part (including `functionCall` parts) in the next request, whether or not effort is set.
- AC11: A user can set reasoning effort (off/low/medium/high) from the shell and from configuration, and the value reaches `request.options.reasoning` for the main agent turn; default is off.
- AC12: `runModelTurn` with a reasoning fixture returns text without the reasoning; next-step suggestion, `wiki enrich`, memory writes, session titles and subagent result summaries use only answer text (tests).
- AC13: `wiki enrich` never writes a page containing `<think>`/`</think>` (reasoning is stripped or the page is rejected), and `keryx wiki status` reports existing pages that contain such tags.
- AC14: Next-step suggestion runs with an abort signal combining the foreground operation and a timeout, is cancelled when a new turn starts or the user types, uses the current model selection, is discarded when empty, longer than 80 characters or containing `<` or `>`, and a bare Enter on an empty composer does not submit it (Tab/Right still accepts it).
- AC15: Session messages carry the timestamp at which each was appended; messages of one turn no longer all share the checkpoint time; sessions written by older versions still load.
- AC16: The TUI receives reasoning deltas live (new AgentIO hook), shows a thinking indicator from the first reasoning delta, renders the finished reasoning block with duration and reasoning tokens when known, marks redacted reasoning, and supports `/think auto|expand|hide` persisted across sessions; non-TUI AgentIO implementations keep working.
- AC17: README and the docs site document reasoning configuration (`reasoning` in `llm-providers.json`, MiniMax example), the effort control, the `/think` display modes, and provider timeouts.
- AC18: `bun run check` passes and `keryx health run` gate is pass on the branch.
- AC19: A smoke run of the built keryx against a real reasoning provider (MiniMax with split format, or another available one) shows streamed output with no `<think>` in the answer and a working tool loop; if no credentials are available the report states it was not run.

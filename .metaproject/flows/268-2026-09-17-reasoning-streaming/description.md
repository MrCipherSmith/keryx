# Provider streaming, timeouts and reasoning handling

Source analysis: `docs/analysis/minimax-shell-hang/2026-09-17/report.md`.

## Problem

With MiniMax-M3, `keryx shell` looks hung. Four defects combine:

1. The OpenAI-compatible and OpenAI Responses adapters read the whole SSE body with
   `await response.text()` — no incremental events, no first-byte or idle timeout, and a
   server that does not close the socket after `[DONE]` holds the turn forever.
2. `budget.maxOutputTokens` never reaches the compat (`max_tokens`) or Responses
   (`max_output_tokens`) payload.
3. Inline `<think>…</think>` in `content` is not recognised; reasoning leaks into the
   answer, history, next-step suggestion and `wiki enrich` pages.
4. `suggestNextStep` runs with no signal/timeout, a weak sanitizer, the start-time model,
   and Enter on an empty composer sends the hint as a new turn.

Behind defect 3 is a broader gap: keryx does not request reasoning from Anthropic, OpenAI
or Gemini, has no place to keep reasoning (or its opaque signatures) in history, so it
cannot replay it where a provider requires it (Anthropic thinking signatures, Gemini 3
`thoughtSignature`, DeepSeek `reasoning_content`, MiniMax `<think>`/`reasoning_details`),
and the TUI shows reasoning only after the model has finished thinking.

## Expected outcome

- Model output streams incrementally; stalled or never-closed streams end with a typed,
  retryable error instead of a spinner.
- Output limits are sent to every provider.
- Reasoning arrives as `reasoning_delta` for every supported protocol, including inline tags
  and MiniMax `reasoning_split`, is kept on the assistant message and replayed per provider
  rules, and never leaks into derived data (suggestion, wiki, memory, titles).
- The TUI shows reasoning live, with a thinking phase that starts on the first reasoning
  delta, a final block with duration and tokens, a redacted marker, and a show mode.
- Suggestion hint is bounded, sanitized, cancellable and never auto-sent by a bare Enter.
- `wiki enrich` refuses to write reasoning into pages; session message timestamps are real.

## Out of scope

- Repairing already-corrupted wiki pages in other projects (olimpyx) beyond detection.
- New providers or model catalogues.
- Measuring how much past-turn reasoning to replay for providers that do not require it
  (default: do not replay).

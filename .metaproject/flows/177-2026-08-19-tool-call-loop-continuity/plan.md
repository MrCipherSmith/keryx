# Implementation Plan

Status: chosen

## Approach

Additive fields on the normalized message, one shared pure linking helper, and
per-adapter serialization on top of it. `NormalizedMessage` is not in the frozen
contracts registry (`src/contracts` does not reference it), and every new field
is optional, so a message written by today's code stays valid.

The invariant that keeps this safe is enforced in ONE place: an assistant's
`tool_calls` and a tool result's `tool_call_id` are only emitted when they link
up **inside the request being sent**. Compaction, resume, an aborted batch, or a
budget-denied call can all leave a half-pair; each adapter would otherwise send a
request the API rejects outright (OpenAI 400s on a `role:"tool"` with no
preceding call, and on an assistant call with no answer). Rather than trusting
every upstream path to preserve pairs, the linker computes the pairing from the
messages themselves and anything unpaired falls back to exactly today's framed
text. Correct requests get the real loop; degenerate ones get the current
behaviour, never an error.

Rejected alternative — teaching `compactMessages` and the session store to keep
pairs intact and trusting that everywhere. It is the same guarantee spread over
more code, and any future producer of history has to remember it.

## Steps

1. **`src/harness/provider/types.ts`.** Add `NormalizedToolCall` (`id`, `name`,
   `arguments` — the raw JSON string the provider emitted) and two optional
   fields: `toolCalls?: NormalizedToolCall[]` on an assistant message,
   `toolCallId?: string` on a tool message.
2. **`src/harness/provider/tool-call-linking.ts` (new).** Pure
   `linkToolCalls(messages)` → for each message, the calls that are answered
   later in the same array, and for each tool message, whether its anchor call
   appears earlier. Unanswered calls and orphaned results are reported as
   degraded so callers render them as text.
3. **`src/commands/agent.ts`.** When a round emits tool calls, record the
   assistant turn carrying them (merging into the streamed text message when the
   model also produced text, so the turn is not duplicated), and stamp each tool
   result message with its `toolCallId`.
4. **`src/harness/provider/ollama/ollama-provider.ts`.** Serialize a linked
   assistant message as `{role:"assistant", content, tool_calls:[{id, type:
   "function", function:{name, arguments}}]}` and a linked result as
   `{role:"tool", tool_call_id, content}`. Unlinked messages keep the existing
   `Tool result:`-framed user message verbatim.
5. **`src/harness/provider/anthropic/anthropic-provider.ts`.** Serialize a linked
   assistant message as content blocks (`text` + `tool_use` with parsed input)
   and a linked result as a user message with a `tool_result` block. Unlinked
   messages keep today's plain mapping.
6. **`src/session/store.ts`.** Persist and validate the two new fields so a
   resumed session keeps its loop; a malformed field is dropped, never trusted.
7. **Tests.** Adapter payload tests for both providers, a linker unit suite for
   the degenerate cases, a driver test asserting the second request contains the
   assistant call, a store round-trip, and a compaction test proving a cut
   between a call and its result still produces a valid request.

## Risks

- **A provider that dislikes `tool_calls` echoed back.** Every OpenAI-compatible
  API in the picker documents this exact shape, and it is what their own clients
  send; the risk is a non-conforming gateway. Contained by the linker: the shape
  is only produced when a real pair exists, and a bad gateway is one adapter fix
  away rather than a driver change.
- **`arguments` is provider text, not validated JSON.** It is passed through
  verbatim for OpenAI-compat (which expects a string) and `JSON.parse`d with a
  fallback to `{}` for Anthropic (which expects an object). A malformed argument
  string therefore cannot throw during serialization.
- **Transcript growth.** Echoing calls back adds tokens per round. This is the
  cost of the loop the models expect, and it replaces the retry rounds the
  missing loop was causing.

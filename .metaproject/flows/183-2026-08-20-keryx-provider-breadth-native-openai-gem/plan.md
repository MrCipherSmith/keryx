# Implementation Plan

Status: formalized from docs/requirements/keryx-provider-breadth/ (draft) +
live vendor-shape research (see context.md) — both design questions the
spec left open (§4: which OpenAI API shape; Gemini's exact mapping) are
now resolved below, sourced from current vendor documentation, not
assumed.

## Approach

Extract first, then build both new adapters against the extracted engine
and `AnthropicProvider`'s template — sequenced this way per the docpack's
own D-02/Recommendation: building two new adapters next to a
not-yet-extracted `OllamaProvider` risks a third example of the same
misleading pattern.

## Vendor wire-shape decisions (from research, not assumed)

### OpenAI: Responses API (`POST /v1/responses`), not Chat Completions

Chat Completions stays supported but is not where new agentic features
land (reasoning items, hosted tools). Request: `model`, `input`
(string or item array — NOT the Chat Completions `messages[]` shape),
`instructions` (top-level system string), `tools[]`,
`parallel_tool_calls`, `text.format` (structured output),
`reasoning.summary`/`reasoning.effort`, `stream`. SSE event `type`
strings (confirmed): `response.created`, `response.output_item.added`/
`.done`, `response.output_text.delta`/`.done`,
`response.function_call_arguments.delta`/`.done`, `response.completed`,
`response.failed`/`.incomplete`, terminal `error`. Every event carries
`sequence_number`. Tool-call correlation key is `call_id` (not `id`) —
maps to `NormalizedEvent.toolCallId`. Usage on `response.completed`:
`usage.{input_tokens, output_tokens, total_tokens,
output_tokens_details.reasoning_tokens, input_tokens_details.cached_tokens}`.
Auth: `Authorization: Bearer <key>`, env `OPENAI_API_KEY`.

**Defensive note from research**: a documented (third-party-reported)
bug — context-length overflow on the streaming path returns the
terminal `error` event with an EMPTY `message`. Do not surface an empty
string to the operator; classify defensively (context_overflow, generic
message) rather than trusting message content on that one path.

### Gemini: legacy `generateContent`/`streamGenerateContent`, NOT the newer Interactions API

**Explicit architectural decision, not a gap** — see description.md.
Google's Interactions API (GA, "recommended for all new projects") is
session/continuation-shaped (`previous_interaction_id`), a structural
mismatch with keryx's stateless `NormalizedRequest`. `generateContent`
is labeled "legacy" but explicitly remains fully supported, and its flat
`contents[]` array (`{role: "user"|"model", parts}`, no `system` role —
system prompt is a separate top-level `systemInstruction` field) is the
actual structural fit. Streaming via `streamGenerateContent?alt=sse`.
Tool calls: `functionDeclarations` in `tools[]`; a call appears as a
`functionCall:{name,id,args}` part; the result goes back as a
`role:"user"` message with a `functionResponse:{name,id,response}` part
(not a separate tool/function role). Parallel tool calls confirmed
supported (multiple `functionCall` parts in one turn). Usage:
`usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount,
cachedContentTokenCount, thoughtsTokenCount}`. Auth: `x-goog-api-key`
header; env `GEMINI_API_KEY` (and `GOOGLE_API_KEY` — Google wins if both
set; prefer `GEMINI_API_KEY` as primary per specification.md §2's naming
note, fall back to `GOOGLE_API_KEY`).

### Capability matrix (per-vendor, not copied from AnthropicProvider)

OpenAI: streaming=true, toolCalls=true, parallelToolCalls=true (model-
dependent, default true), structuredOutput=true (`text.format` + strict
function tools), reasoningMetadata=true (SUMMARY only, never raw trace —
`reasoning.summary` opts in), promptCaching=true (automatic/opaque,
observed via `usage.input_tokens_details.cached_tokens`, no cache-object
management needed — honest for a stateless adapter), vision=true
(`input_image` content part — exact shape to confirm during
implementation, flagged unconfirmed in research), tokenCounting=false
(no dedicated endpoint; only post-response `usage`), modelListing=false
(no fixture/test proves it — do not claim).

Gemini: streaming=true, toolCalls=true, parallelToolCalls=true
(confirmed), structuredOutput=true (`responseSchema`+
`responseMimeType:"application/json"`), reasoningMetadata=UNCONFIRMED
in research (exact `thinkingConfig` shape not directly quote-confirmed —
implementer must verify before claiming `true`; default to `false` if
not confirmed during implementation, per specification.md §5's "each
claimed true needs a corresponding fixture, not a guess"), promptCaching=true
(implicit/automatic for Gemini 2.5+, `cachedContentTokenCount` — do NOT
claim the separate explicit `CachedContent` resource path), vision=true
(`inlineData`/`fileData` parts), tokenCounting=true (dedicated
`{model}:countTokens` endpoint exists — implementer decides whether to
wire it or declare the capability without wiring the endpoint; if not
wired, do not claim `true`).

## Steps

1. **Extract the compat engine**: move `OllamaProvider`'s stream/parse
   logic (everything except Ollama-specific identity: `DEFAULT_BASE_URL`,
   `PROVIDER_REVISION`, `DEFAULT_MODEL`, `describe()`'s provider id) into
   a new, parameterized module (`src/harness/provider/compat/
   openai-compat-provider.ts`, name per specification.md §1). `OllamaProvider`
   becomes a thin wrapper constructing the compat engine with Ollama's
   defaults (loopback allowed, no key required) OR is retired in favor of
   direct construction — implementer's call per specification.md §1,
   record the chosen shape. Every existing caller/test (`select.ts`,
   `select.test.ts`, `providers.ts`, `ollama-provider.test.ts`,
   `make-provider.ts`, `make-provider.test.ts`, `guard.loopback.test.ts`
   — the 8-file blast radius named in PRD Risks) must pass unchanged in
   outcome.
2. **`OpenAiProvider`**: new adapter targeting the Responses API per the
   vendor-shape decision above, reusing `AnthropicSSEParser` + the SSRF
   guard + `linkToolCalls`/`defaultRetryable` from `provider-port.ts`.
3. **`GeminiProvider`**: new adapter targeting `generateContent`/
   `streamGenerateContent` per the vendor-shape decision above, same
   reuse pattern. Gemini's SSE framing needs verification against
   `AnthropicSSEParser`'s assumptions (generic `data:`-line framer) —
   confirm compatibility or note if Gemini's `alt=sse` stream needs
   different handling.
4. **`make-provider.ts`**: two new named branches (`openai`, `gemini`),
   same shape as the existing `anthropic` branch — read env credential,
   fall back to `FakeProvider` when absent/empty, never attempt network
   without a credential.
5. **`select.ts`**: add `openai`/`gemini` as first-class picker entries.
6. **Fixtures**: `.SYNTHETIC.`-caveated (see description.md's "known
   deviation"), hand-authored from this plan's researched wire shapes,
   covering at minimum a clean streamed response, a tool-call round
   trip, and one error case per vendor.
7. **SSRF/egress guard test**: analogous to `guard.loopback.test.ts`,
   proving both new adapters deny private/loopback/metadata egress the
   same way the existing two adapters do (AC4).

## Risks

- Vendor wire-shape drift: mitigated by explicit, sourced research
  (context.md) rather than training-data recall, but NOT live-verified —
  named risk carried forward, not resolved.
- Extraction blast radius (8 files) — mitigated by running every listed
  file's existing test suite before/after and treating any behavior
  change as deliberate, not incidental (AC3).
- Capability-matrix overclaiming — mitigated by the per-vendor matrix
  above being sourced from research with unconfirmed items explicitly
  named `false`-until-confirmed rather than assumed `true`.

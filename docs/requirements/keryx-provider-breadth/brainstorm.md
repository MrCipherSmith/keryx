# Keryx Provider Breadth — Brainstorm
Version: 0.1.0

## Origin

From the same comparative research pass that produced `keryx-mcp-client`:
provider breadth was ranked the #2 gap-closing priority (after MCP client)
by impact × ease. This package's own direct source reading (this session,
not the original research pass) sharpened the gap's actual shape.

## Reference designs studied (from the prior gap-closing research)

### opencode (`packages/llm`)

A hand-rolled multi-protocol layer separating wire format from provider
identity: each real wire protocol (openai-responses, openai-chat,
anthropic-messages, gemini, bedrock-converse) is its own module on one shared
`Route`/protocol contract, normalized into one Effect-Schema events contract.
The long tail of OpenAI-compatible vendors is NOT hand-coded per vendor —
`openai-compatible-chat.ts` (24 lines) reuses the native OpenAI Chat protocol
with only the endpoint swapped, each vendor a one-line profile entry.

Relevance: the direct template this package follows. keryx's own
`ProviderPort` (`NormalizedEvent`/`ProviderPort`) is already the same kind of
provider-neutral, SDK-free contract opencode's `Route` abstraction is —
confirmed by reading `types.ts` directly, not assumed from the research
summary. The gap is exactly "one native module per real wire format we
actually need, keep the generic adapter for the compat long tail" — which
this package's D-03 reapplies.

### cline (`sdk/packages/llms`)

150+ provider entries live in a generated data catalog pulled from
models.dev; a factory registry maps each provider's declared "family" to a
lazily-imported factory, all built on the Vercel AI SDK.

Relevance: rejected as a model for keryx specifically because adopting it
means taking a dependency on the Vercel AI SDK, which conflicts with the
SDK-free design stated directly in `provider/types.ts`'s own header comment
("deliberately SDK-free: no concrete provider client package... is imported
here"). The one transferable idea — a generated catalog for the compat long
tail, populated from a source like models.dev instead of hand-maintained —
is out of scope for this package (see README non-goals) but worth a future,
separate note.

### deepseek-harness (`packages/llm/llm-pi-ai`)

Outsources the entire multi-protocol matrix to a third-party package,
`@earendil-works/pi-ai`.

Relevance: rejected for the same SDK-free reason as cline, more directly —
this is a single external dependency becoming the source of truth for every
non-Anthropic wire protocol, an explicit conflict with keryx's stated design,
not a partial one.

### codex (`ModelProviderInfo`)

A pure data struct with zero per-provider code; users extend the catalog
entirely from a config file. Narrowed to ONE wire protocol (OpenAI Responses)
system-wide to make this possible — no Gemini/Anthropic-native support
anywhere.

Relevance: the "provider is data, not code" idea is exactly what keryx's
existing `OPENAI_COMPAT_PROVIDERS` registry already does for the compat long
tail (confirmed reading `providers.ts` directly — 9 real entries, all pure
data). codex achieved zero-code-per-provider by eliminating multi-protocol
support, which is the opposite of this package's goal (adding two more real
protocols), so this is evidence FOR keryx's existing split (data for the
compat tail, code for real protocol differences) rather than a pattern to
adopt further.

## Current-state findings (this session, direct source reading)

Not assumed from the original research pass — read directly, since the
research pass's own informal claim ("8 providers via one generic adapter")
undersold exactly how tangled the naming is:

- `src/harness/provider/types.ts`: `ProviderPort` is `describe()` +
  `stream(request, opts): AsyncIterable<NormalizedEvent>`. Exactly 2 real
  implementations exist: `AnthropicProvider`, `OllamaProvider`.
- `src/harness/provider/ollama/ollama-provider.ts`'s own header comment: "A
  THIN `fetch` + SSE adapter over the Ollama OpenAI-compatible `POST
  /v1/chat/completions` endpoint." Reused generically per
  `src/commands/providers.ts`'s own header comment: "a single OpenAI-compatible
  adapter (`OllamaProvider` with an `apiKey`/`baseUrl` grant) serves all of
  them."
- `src/commands/providers.ts`'s `OPENAI_COMPAT_PROVIDERS`: exactly 9 entries
  (openrouter, deepseek, zai, zai-coding, cerebras, groq, rapid-mlx,
  moonshot, grok) — all pure data (baseUrl/envKey/chatPath), all reachable
  because they genuinely speak OpenAI Chat Completions shape.
- `src/harness/provider/anthropic/anthropic-provider.ts`'s own header
  comment: "The FIRST real `ProviderPort`." Confirms it as the deliberate
  template, not one of several equally-authoritative examples.
- Both existing adapters share `AnthropicSSEParser` (SSE line-framing),
  `defaultRetryable`, `linkToolCalls` — real shared infrastructure this
  package's two new adapters reuse rather than reinvent.
- `OllamaProvider` blast radius (`rg -l OllamaProvider src`): 8 files —
  `select.ts`, `select.test.ts`, `providers.ts`, `ollama-provider.ts`,
  `ollama-provider.test.ts`, `make-provider.ts`, `make-provider.test.ts`,
  `harness/mutation/guard.loopback.test.ts`. Named explicitly in decisions.md
  D-02 as an accepted, not hidden, cost.

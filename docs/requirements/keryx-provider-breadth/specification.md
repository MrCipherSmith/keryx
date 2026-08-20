# Keryx Provider Breadth — Specification
Version: 0.1.0

**Status: draft.** Architecture and integration points are grounded in direct
source reading; exact vendor wire shapes (§4) are explicitly marked
unverified and must be confirmed live before fixtures are authored.

## 1. Identity

Three module changes under `src/harness/provider/`:

- `src/harness/provider/openai/openai-provider.ts` (new) — native OpenAI
  adapter.
- `src/harness/provider/gemini/gemini-provider.ts` (new) — native Gemini
  adapter.
- `src/harness/provider/compat/openai-compat-provider.ts` (new, name
  provisional) — the generic OpenAI-Chat-Completions engine extracted out of
  `src/harness/provider/ollama/ollama-provider.ts`. `ollama-provider.ts`
  either becomes a thin wrapper constructing the compat engine with
  Ollama-specific defaults (loopback allowance, no key required), or is
  retired in favor of callers constructing the compat engine directly for
  the `"ollama"` name — exact shape decided during implementation, recorded
  in decisions.md once chosen, not preempted here.

All three follow the established template (`AnthropicProvider`,
`OllamaProvider`): a plain class/factory taking injected `deps: { fetch,
grant, clock? }`, no vendor SDK import, SSE parsing reusing
`AnthropicSSEParser` (already shared across adapters — confirmed in both
existing adapters' imports), shared `defaultRetryable`/`linkToolCalls`
helpers from `provider-port.ts`/`tool-call-linking.ts`.

## 2. Registry changes

`src/commands/providers.ts` currently holds one registry
(`OPENAI_COMPAT_PROVIDERS`) for the generic-compat long tail. `openai` and
`gemini` are NOT added to this registry — they are native providers,
constructed by name directly in `make-provider.ts` the same way `"anthropic"`
already is (a dedicated `if (name === "openai")` branch reading its own
credential env var), not through the compat-entry data path. This mirrors
`AnthropicProvider`'s own treatment exactly; a native provider is code, a
compat gateway is data (this repo's own precedent, per
`keryx-external-agent-runtime` D-06's identical reasoning for a different
subsystem).

`make-provider.ts` gains two new named branches, each following
`AnthropicProvider`'s exact shape: read the credential env var
(`OPENAI_API_KEY`, `GEMINI_API_KEY` — names to confirm against what
`keryx-provider-auth`'s existing registry conventions expect, since that
package already anticipates "OpenAI (conspicuously absent today)" as a
future native entry), construct with a capability grant, or fall back to
`FakeProvider` when the key is absent/empty — never attempt network without
a credential, exactly like the existing `anthropic` branch.

## 3. Picker surface

`src/commands/select.ts` (the provider picker) gains `openai`/`gemini` as
first-class entries alongside `anthropic`/`ollama`, not folded into the
compat-registry-driven picker rows. Existing behavior for the 9 compat
entries and `anthropic`/`ollama` themselves is unchanged — this is additive,
verified by `select.test.ts` continuing to pass plus new cases for the two
additions.

## 4. Data contracts — UNVERIFIED, confirm live before implementation

Neither vendor's current wire shape was probed as part of writing this
specification. What is known and can be stated now:

- Both are SSE-streaming, HTTP APIs reachable with an injected `fetch` and a
  Bearer/API-key credential — consistent with the existing adapter shape,
  no architectural surprise expected here.
- OpenAI has (as of general knowledge, not live-verified for this document)
  two documented API shapes — the older Chat Completions format (which the
  existing compat engine already speaks generically) and a newer Responses
  API with a different event/item vocabulary. **Which shape this adapter
  targets is an implementation-time decision requiring a live check against
  current OpenAI documentation**, not assumed here — the Responses API is
  the more likely target given it is the more capable, current one, but this
  is not committed as a specification fact.
- Gemini's function-calling and content-part shapes are structurally
  different from OpenAI's (multi-part content blocks, a distinct
  function-call/function-response turn shape) — this specification does not
  attempt to pin the exact `NormalizedEvent` mapping table here, the way
  `keryx-mcp-client`'s specification declined to pin codex's exact
  elicitation payload before a live probe. **Fixtures come from a live
  probe, not from documentation alone** (see PRD Risks).

## 5. Capability matrix honesty

Each new adapter's `describe()` must declare `ProviderCapabilities`
truthfully per vendor, not copy `AnthropicProvider`'s matrix. Specifically to
verify before implementation, not assume:

- `promptCaching` — Anthropic and OpenAI both have some form of this; exact
  applicability to a from-scratch adapter is unverified here.
- `parallelToolCalls`, `structuredOutput`, `reasoningMetadata` — likely differ
  between OpenAI's two API shapes and definitely differ for Gemini; each
  claimed `true` needs a corresponding fixture proving it, not a guess.

## 6. Acceptance Criteria

- AC1: `OpenAiProvider implements ProviderPort`, constructed via
  `makeProvider("openai", ...)`, streams a real request and yields correctly
  normalized events — verified against a live API call at least once
  (fixture-replay tests are not sufficient alone, per this repo's own
  recurring lesson about vendor documentation vs. live behavior diverging).
- AC2: `GeminiProvider implements ProviderPort`, same bar as AC1 for Gemini.
- AC3: The extracted compat engine (§1) is a distinct, separately-testable
  module; `ollama-provider.test.ts` and every other file listed in PRD Risks
  either passes unchanged or has its changes reviewed as deliberate, not
  incidental.
- AC4: Both new adapters enforce the same SSRF/egress guard
  (`isPrivateEgressHost`) as the existing two adapters, verified by a test
  analogous to `guard.loopback.test.ts`.
- AC5: `describe()` on both new adapters is verified against real API
  behavior for every capability claimed `true` — a claimed-but-unverified
  capability is a specification violation, not a minor gap.
- AC6: No vendor SDK dependency is added — verified the same way
  `AnthropicProvider`/`OllamaProvider`'s own "no new dependency" claim is
  verified (import audit).

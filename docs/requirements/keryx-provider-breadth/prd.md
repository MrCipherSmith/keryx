# Keryx Provider Breadth — PRD
Version: 0.1.0

## Problem

keryx's provider layer is genuinely well-designed at the boundary
(`ProviderPort`: SDK-free, `describe()` + `stream()`, a strict
`NormalizedEvent` vocabulary) but narrow behind it. Reading
`src/harness/provider/` directly, not just the earlier comparative research
summary, shows exactly two real adapters exist: `AnthropicProvider` and
`OllamaProvider`. `OllamaProvider` is not what its name suggests — per its own
registry's header comment, it is "a single OpenAI-compatible adapter" reused
for OpenRouter, DeepSeek, Z.AI (both plans), Cerebras, Groq, Moonshot, and
Grok, none of which have anything to do with Ollama. Two real wire protocols
are entirely absent: OpenAI's own API, and Google's Gemini API — the two gaps
the earlier research pass named specifically (native OpenAI "conspicuously
absent," per `keryx-provider-auth`'s own roadmap entry; no Gemini path at
all).

This is a real product gap, not a cosmetic one: an operator who wants to run
keryx against their own OpenAI account, or against Gemini, cannot — the
generic adapter only speaks the OpenAI *Chat Completions* shape, and neither
OpenAI's modern Responses API nor Gemini's API fit it.

## Goal

Two new native `ProviderPort` adapters (OpenAI, Gemini), built to the same
template `AnthropicProvider` already established (the "FIRST real
`ProviderPort`," per its own header comment) — `fetch`-injected,
capability-grant-gated, no vendor SDK, pure translation into
`NormalizedEvent`. Alongside them, extract the generic compat engine
currently trapped inside `OllamaProvider` into its own honestly-named module.

## Users

- An operator with their own OpenAI or Gemini API key who currently has no
  way to point keryx at either, natively.
- Future maintainers reading `make-provider.ts` cold, who today would
  reasonably assume `OllamaProvider` is Ollama-specific and be surprised to
  find it servicing seven unrelated hosted gateways.

## Requirements

1. A native OpenAI adapter implementing `ProviderPort`, speaking OpenAI's own
   API (verify the current Responses-vs-Chat-Completions shape live against
   OpenAI's documentation at implementation time — do not assume this
   document's understanding is current; the sibling
   `keryx-external-agent-runtime` package's own experience is that written
   vendor documentation and live behavior have disagreed before).
2. A native Gemini adapter implementing `ProviderPort`, speaking Google's
   Gemini API (same live-verification requirement as Requirement 1).
3. Both adapters normalize fully into the existing `NormalizedEvent`/
   `NormalizedError`/`NormalizedUsage` vocabulary — no widening of
   `NormalizedEventKind` or `ProviderErrorKind` unless a real capability
   cannot be expressed in the existing 8/9 values (in which case, that is
   itself a decision to record, not a silent addition).
4. Both adapters are constructible through `makeProvider` (`make-provider.ts`)
   by provider name, following the same `env`/`credentials`-scoped lookup
   `AnthropicProvider`/`OllamaProvider` already use — no separate
   construction path.
5. The generic OpenAI-Chat-compatible engine currently embedded in
   `OllamaProvider` is extracted into its own module with an honest name.
   `OllamaProvider` (or its replacement) continues to serve real Ollama
   installs, reusing the extracted engine rather than duplicating its SSE/
   request-shaping logic.
6. Every existing registry entry in `src/commands/providers.ts` and every
   existing test asserting current `OllamaProvider`-as-compat-engine
   behavior continues to pass unchanged in outcome, even where the
   underlying module structure changes — this is a rename/extraction, not a
   behavior change, for the 9 entries already served.
7. No new runtime dependency. Both new adapters follow
   `AnthropicProvider`/`OllamaProvider`'s own constraint: injected `fetch`
   only, no vendor SDK.
8. Credential handling for both new adapters is a plain Bearer/API-key grant,
   matching every existing adapter today — richer auth methods are
   `keryx-provider-auth`'s concern, not this package's.

## Success Criteria

- An operator can select `openai` or `gemini` as a provider (same picker
  surface `select.ts` already offers for `anthropic`/`ollama`/the compat
  registry) and get a real, working, streamed response.
- `OllamaProvider`'s existing test suite (`ollama-provider.test.ts`) and every
  other file touching it today (`select.ts`, `select.test.ts`,
  `make-provider.ts`, `make-provider.test.ts`, `guard.loopback.test.ts`) is
  either unchanged in behavior or deliberately, visibly updated — not
  silently broken by the extraction.
- Both new adapters have SSRF/egress guarding equivalent to
  `OllamaProvider`'s (`isPrivateEgressHost`/`isLoopbackHost` from
  `harness/mutation/guard.ts`) even though neither is expected to need a
  loopback opt-in — consistency of the security posture across adapters,
  not just the two already shipped.

## Risks

- **Vendor wire-shape drift.** Neither OpenAI's nor Gemini's exact current
  request/response/streaming shape has been verified live as part of writing
  this PRD — both must be confirmed against current vendor documentation (and
  ideally a live probe) before fixtures are authored, the same lesson
  `keryx-external-agent-runtime` and `keryx-mcp-client` both record.
- **Extraction blast radius.** 8 files reference `OllamaProvider` today
  (`select.ts`, `select.test.ts`, `providers.ts`, `ollama-provider.ts`,
  `ollama-provider.test.ts`, `make-provider.ts`, `make-provider.test.ts`,
  `guard.loopback.test.ts`). A careless rename risks silently changing
  behavior for the 9 already-shipped compat providers, which is a much wider
  blast radius than adding two new adapters cleanly would carry alone.
- **Capability-matrix honesty.** OpenAI's Responses API and Gemini's API
  likely differ from Anthropic's in which of the 9 `ProviderCapabilities`
  flags they can honestly claim (e.g. prompt caching, parallel tool calls).
  Overclaiming a capability a new adapter cannot actually deliver is worse
  than declaring it absent — `describe()`'s whole purpose is letting callers
  degrade correctly.

## Recommendation

Proceed to specification. Sequence the two requirements this PRD scopes
together (Requirement 5's extraction, Requirements 1–2's new adapters) rather
than doing the extraction as an afterthought — building OpenAI/Gemini next to
a not-yet-extracted `OllamaProvider` risks a third adapter copying the same
misleading pattern instead of fixing it.

# Keryx Provider Breadth — Decisions
Version: 0.1.0

## D-01: Both OpenAI and Gemini together, not sequenced

**Decision.** Ship native OpenAI and Gemini adapters in the same package, not
one first with the other deferred.

**Reasoning.** Both are equally real, named gaps from the original
comparative research (OpenAI "conspicuously absent" despite the generic
adapter literally speaking its Chat Completions shape; Gemini absent
entirely). Neither is clearly higher-value enough to justify staging —
OpenAI's irony (the compat engine already imitates its older API without
supporting its own account) and Gemini's distinct model family are different
kinds of value, not comparable on one axis. Building both against the same
`AnthropicProvider` template in one pass also amortizes the one real design
question that applies to both (§5's capability-matrix honesty) rather than
re-deriving it twice.

## D-02: Extract the compat engine out of `OllamaProvider`

**Decision.** The generic OpenAI-Chat-Completions-compatible engine currently
embedded in `ollama-provider.ts` becomes its own, honestly-named module. Not
deferred as a follow-up cleanup.

**Reasoning.** A third adapter (this package adds two) built next to an
un-extracted `OllamaProvider` would either duplicate its SSE/request logic a
second time or add a third caller confused about why a provider-agnostic
compat path lives inside an Ollama-named class. The confusion this decision
fixes is real, not stylistic: `make-provider.ts`'s own compat branch already
constructs `new OllamaProvider(...)` for OpenRouter, DeepSeek, Z.AI, Cerebras,
Groq, Moonshot, and Grok — a maintainer reading that cold has no reason to
expect it.

**Accepted cost.** 8 files reference `OllamaProvider` today; this is a wider
blast radius than adding two clean new adapters would carry alone (see PRD
Risks). Accepted because deferring it means keryx would ship a third example
of the same misleading pattern this decision exists to stop.

## D-03: Native providers are code, compat gateways stay data

**Decision.** `openai` and `gemini` are constructed as dedicated named
branches in `make-provider.ts` (like `anthropic` today), not as entries in
`src/commands/providers.ts`'s `OPENAI_COMPAT_PROVIDERS` registry.

**Reasoning.** The registry's own existence is justified by every entry in it
being reachable through the SAME generic shape (base URL + Bearer key,
answering OpenAI Chat Completions). OpenAI's own API (once on the Responses
shape, per specification.md §4) and Gemini's API are not that shape — forcing
them into the compat registry would either lie about their wire format or
require the registry to grow a discriminant it does not have today. This is
the identical reasoning `keryx-external-agent-runtime` D-06 already applied
to a different subsystem (registry metadata is data; parsing that differs
structurally is code) — reused here, not reinvented.

# Keryx Provider Breadth
Version: 0.1.0

## Purpose

Add native `ProviderPort` adapters for the two real LLM wire protocols keryx
does not speak today — OpenAI's own API and Google's Gemini API — and
disentangle the existing generic OpenAI-Chat-Completions-compatible adapter
from the misleadingly-named class it currently lives in (`OllamaProvider`).

Driven by a prior comparative research pass (8 agents, 17-dimension rubric,
7 peer coding-agent harnesses): keryx covers 8–9 hosted providers, but
*every one of them* — including things with no structural relationship to
Ollama at all (OpenRouter, DeepSeek, Z.AI, Cerebras, Groq, Moonshot, Grok) —
is served by one adapter class named for a specific local runtime it also
happens to serve. opencode's `packages/llm` was the strongest studied
pattern for closing this without abandoning keryx's existing SDK-free,
provider-neutral `ProviderPort` design: one native module per real wire
format, one thin generic module for the OpenAI-Chat-compatible long tail.

## Status

**implemented** (AC3–AC6 confirmed; AC1/AC2 explicitly not met — no live
API key in this environment, a pre-approved deviation, not a silent
downgrade; flow 183, PR #364). `OpenAiProvider`
(`src/harness/provider/openai/openai-provider.ts`, Responses API,
`call_id` correlation) and `GeminiProvider`
(`src/harness/provider/gemini/gemini-provider.ts`, legacy
`generateContent`/`streamGenerateContent`) both implement `ProviderPort`
and are wired additively into `make-provider.ts` and `select.ts`'s picker.
The generic OpenAI-Chat-Completions-compatible engine formerly embedded in
`OllamaProvider` was extracted into its own module
(`src/harness/provider/compat/openai-compat-provider.ts`, `OpenAiCompatEngine`)
with zero behavior change verified across the 8-file blast radius (AC3);
`OllamaProvider` is kept as a thin wrapper over it (2 test files construct
it directly). Both new adapters enforce the same SSRF/egress guard as the
existing two (AC4), declare capabilities only where confirmed against
live-researched vendor documentation rather than guessed (AC5), and add no
vendor SDK dependency (AC6, import-audited).

**AC1 and AC2 are explicitly not met**, named as such rather than
overclaimed: no `OPENAI_API_KEY`/`GEMINI_API_KEY` was available to verify
against a real live API call. What is delivered instead: both adapters
build/stream/normalize correctly against `.SYNTHETIC.`-caveated fixtures
under `fixtures/provider-breadth/{openai,gemini}/`, sourced from
live-researched current vendor docs (not training-data recall), with
provenance and unconfirmed shape details named in each fixture's
`manifest.json`. Live verification against a real key remains an open
follow-up. A post-review fix round also closed 4 real gaps found in this
same PR's own new work — `single-turn.ts` auto-provider-detection and the
sandbox credential-masking allowlist both silently ignored `openai`/`gemini`
until fixed — while deliberately leaving pre-existing `OllamaProvider`
behavior (e.g. `classifyHttpError`'s error-collapsing) untouched, per AC3's
zero-behavior-change requirement.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Identity, structure, data contracts, integration points, acceptance criteria. |
| [decisions.md](decisions.md) | Adopted decisions: scope (both providers at once) and the `OllamaProvider` split/rename. |
| [brainstorm.md](brainstorm.md) | Reference designs studied (opencode, cline, deepseek-harness, codex) and current-state findings. |

## Scope

- A native `ProviderPort` adapter for OpenAI's own API.
- A native `ProviderPort` adapter for Google's Gemini API.
- Extracting the generic OpenAI-Chat-Completions-compatible engine currently
  embedded in `OllamaProvider` into its own, honestly-named module, with
  `OllamaProvider` becoming (or being replaced by) a thin, Ollama-specific
  wrapper — reusing the extracted engine rather than duplicating it, the way
  Ollama's own `/v1/chat/completions` endpoint already fits the shape.
- Both new adapters follow the `AnthropicProvider`/`OllamaProvider` template
  already established: `fetch`-injected, capability-grant-gated, no vendor
  SDK, pure translation into the existing `NormalizedEvent` vocabulary.

## Non-goals (this version)

- AWS Bedrock, or any other wire protocol beyond OpenAI and Gemini. Not
  requested; not researched to the depth this package requires for the two
  in scope.
- Any change to `keryx-provider-auth`'s authentication-method work (device
  code, OAuth PKCE, etc.). That package is about *how a credential is
  obtained*; this one is about *what wire protocol is spoken once one
  exists*. OpenAI and Gemini adapters here still take a plain Bearer/API-key
  credential, exactly like `AnthropicProvider` does today — `keryx-provider-auth`
  layering richer auth methods on top is a separate, already-specified
  concern.
- Migrating existing OpenAI-Chat-compatible registry entries (OpenRouter,
  DeepSeek, etc.) onto the new native OpenAI adapter. They stay on the
  generic compat engine — they are not OpenAI's own API, they are
  independent gateways that happen to speak its Chat Completions shape.
- Adding more registry *entries* under the existing generic adapter (e.g. a
  10th OpenAI-compatible gateway). That is already cheap, data-only work
  today and does not need this package.

## Related modules

- [Keryx Project Agent Harness](../keryx-project-agent-harness/README.md) —
  hosts `ProviderPort`, `NormalizedEvent`, and the existing
  `AnthropicProvider`/`OllamaProvider` adapters this package's new adapters
  are built to the same shape as.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — the sibling,
  already-specified package for authentication *methods* per provider entry;
  this package does not duplicate or preempt it.

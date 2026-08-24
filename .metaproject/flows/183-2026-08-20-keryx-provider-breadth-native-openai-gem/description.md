# Keryx Provider Breadth: native OpenAI + Gemini adapters, extract compat engine from OllamaProvider

Status: formalized
Source: docs/requirements/keryx-provider-breadth/ (draft, v0.1.0)

## Problem

`OllamaProvider` is not what its name suggests — per its own header comment it
is a generic OpenAI-Chat-Completions-compatible engine reused for 9 hosted
gateways (OpenRouter, DeepSeek, Z.AI x2, Cerebras, Groq, Moonshot, Grok) that
have nothing to do with Ollama. Two real wire protocols are entirely absent:
OpenAI's own API and Google's Gemini API — an operator with an OpenAI or
Gemini account cannot point keryx at either natively.

## Expected Outcome

- Two new native `ProviderPort` adapters, built to `AnthropicProvider`'s
  template (`fetch`-injected, capability-grant-gated, no vendor SDK):
  - `OpenAiProvider` (`src/harness/provider/openai/openai-provider.ts`),
    targeting the **Responses API** (`POST /v1/responses`), not Chat
    Completions — the recommended API for new integrations per current
    OpenAI documentation (Chat Completions stays supported, but new
    agentic features land only in Responses).
  - `GeminiProvider` (`src/harness/provider/gemini/gemini-provider.ts`),
    targeting the **legacy `generateContent`/`streamGenerateContent`**
    API, not the newer stateful Interactions API — a real architectural
    decision recorded in `plan.md`/`journal.md`: Interactions is Google's
    forward-looking pick but is session/continuation-shaped
    (`previous_interaction_id`), a structural mismatch with keryx's
    stateless, flat `NormalizedRequest.messages[]`; `generateContent` is
    "legacy" in Google's docs but explicitly remains fully supported with
    no announced EOL, and its flat `contents[]` shape is the actual
    structural fit.
- The generic OpenAI-Chat-Completions-compatible engine currently embedded
  in `OllamaProvider` (`src/harness/provider/ollama/ollama-provider.ts`,
  ~600 lines — this class body genuinely IS the generic engine, not a
  thin wrapper around one) extracted into its own, honestly-named module;
  `OllamaProvider` becomes a thin wrapper pinning Ollama-specific defaults
  (loopback allowed, no key required) over the extracted engine.
- `make-provider.ts` gains `openai`/`gemini` as dedicated named branches
  (code, like `anthropic`), NOT compat-registry entries (data) — D-03's
  reasoning, reused from `keryx-external-agent-runtime` D-06.
- `select.ts` (provider picker) gains `openai`/`gemini` as first-class
  entries.
- Both new adapters reuse `AnthropicSSEParser` (generic `text/event-stream`
  parser, already used by `OllamaProvider`) and the existing SSRF/egress
  guard (`isPrivateEgressHost`/`isLoopbackHost` from
  `harness/mutation/guard.ts`).
- Full acceptance criteria: `docs/requirements/keryx-provider-breadth/specification.md`
  §6 (AC1-AC6), carried into this flow's `acceptance-criteria.md` with one
  explicit, user-approved modification (see below).

## Known, explicit deviation from the docpack (user-approved)

**No `OPENAI_API_KEY`/`GEMINI_API_KEY` is available in this environment.**
The docpack's AC1/AC2 require live-API verification ("fixture-replay tests
are not sufficient alone"). The user was asked directly and chose: build
against current vendor documentation (researched live via WebSearch/WebFetch,
not training-data recall), mark AC1/AC2 as **not fully met** rather than
silently softened or overclaimed — the same honest-gap pattern
`keryx-mcp-client` used for its unreproducible missing-`codex_call_id`
fixture. Fixtures for both vendors will be `.SYNTHETIC.`-caveated,
hand-authored from the vendor-shape research in `context.md`, not captured
from a real call. If real API keys become available later, live
verification should be run as a follow-up before fully closing AC1/AC2.

## Out of Scope

- AWS Bedrock or any other wire protocol beyond OpenAI and Gemini.
- Any change to `keryx-provider-auth`'s authentication-method work (device
  code, OAuth PKCE). Both new adapters take a plain Bearer/API-key
  credential, exactly like `AnthropicProvider` today.
- Migrating existing OpenAI-Chat-compatible registry entries (OpenRouter,
  DeepSeek, etc.) onto the new native OpenAI adapter — they stay on the
  extracted generic compat engine.
- Adding more compat-registry entries.
- Gemini's stateful Interactions API (see architectural decision above).

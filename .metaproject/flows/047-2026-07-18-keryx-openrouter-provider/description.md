# Flow 047 — OpenRouter provider

Status: formalized
Source: user request (test the agent via OpenRouter with a cheap tool-capable
model). Driven via flow-orchestrator.

## Problem

keryx supports fake / ollama / anthropic providers. OpenRouter is an OpenAI-
compatible gateway (base https://openrouter.ai/api, POST /v1/chat/completions,
stream + tools) to 400+ models, but keryx cannot use it. The existing ollama
adapter already speaks OpenAI-compatible /v1/chat/completions with tool_calls AND
its egress gate permits public hosts (openrouter.ai is not private/loopback), so
the only gap is the `Authorization: Bearer <key>` header.

## Expected Outcome

1. The OpenAI-compatible adapter accepts an OPTIONAL API key: when present it sends
   `Authorization: Bearer <apiKey>` (plus optional `HTTP-Referer`/`X-Title`); when
   absent its request headers are byte-identical to today (local ollama). The key
   is read only from env and is never logged/stored/echoed.
2. `make-provider` gains an `openrouter` case: with a non-empty `OPENROUTER_API_KEY`
   → the OpenAI-compatible adapter pointed at `https://openrouter.ai/api` with the
   key; with no key → an offline FakeProvider (fail-closed, no network) — mirroring
   the anthropic-no-key behavior.
3. `detectProviders` offers `openrouter` when `OPENROUTER_API_KEY` is set (a small
   static recommended cheap-model list, e.g. openai/gpt-4o-mini), like anthropic —
   so `keryx shell --provider openrouter --model <m> --agent` works and the picker
   lists it.

## Out of Scope

- No new dependency. No change to the ollama (local, no-key) path behavior. No live
  network in tests (fixtures + injected fetch). Not adding OpenRouter's full /models
  listing — a small static recommended list suffices.

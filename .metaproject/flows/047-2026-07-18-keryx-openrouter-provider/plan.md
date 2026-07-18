# Implementation Plan

Status: formalized

## Approach

Reuse the ollama OpenAI-compatible adapter: add an OPTIONAL `apiKey` (+ optional
extra headers) to its capability grant and set the Authorization header when
present. Add an `openrouter` provider name in make-provider (env key) + detect. TDD
with injected fetch fixtures (offline).

## Steps

1. ollama-provider.ts: `OllamaCapabilityGrant.apiKey?` + optional `headers?`;
   request headers add `Authorization: Bearer <apiKey>` (+ extra) only when apiKey set.
2. make-provider.ts: `openrouter` case (env OPENROUTER_API_KEY → adapter @ base
   https://openrouter.ai/api with key; else FakeProvider). ollama/anthropic/fake unchanged.
3. select.ts detectProviders: add openrouter when OPENROUTER_API_KEY set + a static
   recommended model list.
4. Tests: header present iff apiKey (injected fetch); make-provider openrouter with/without key; detect includes openrouter when key set.

## Risks

- Credential handling — key from env only; never logged; the adapter already redacts.
- Behavior drift for local ollama — apiKey optional; header block gated on apiKey presence; existing ollama tests must stay green.

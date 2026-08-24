# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: `docs/requirements/keryx-provider-breadth/specification.md` §6
(AC1-AC6), with AC1/AC2 explicitly modified — user-approved, see
description.md's "Known, explicit deviation from the docpack" — because no
`OPENAI_API_KEY`/`GEMINI_API_KEY` is available in this environment. The
docpack's original wording ("verified against a live API call at least
once... fixture-replay tests are not sufficient alone") is preserved
verbatim in AC1/AC2 below as the standard NOT currently met, immediately
followed by what this flow actually delivers and confirms instead — this
is a recorded, honest partial confirmation, not a silently lowered bar.

## Criteria

- AC1: `OpenAiProvider implements ProviderPort`, constructed via `makeProvider("openai", ...)`, streams a real request and yields correctly normalized events — the docpack standard is "verified against a live API call at least once (fixture-replay tests are not sufficient alone)"; NOT MET in this flow (no API key available). What IS delivered and confirmable: the adapter builds/streams/normalizes correctly against `.SYNTHETIC.`-caveated fixtures sourced from live-researched current OpenAI documentation (not training-data recall), with every fixture's provenance and every unconfirmed vendor-shape detail named explicitly in `fixtures/provider-breadth/openai/manifest.json`. Live verification remains an open follow-up.
- AC2: `GeminiProvider implements ProviderPort`, same bar as AC1 for Gemini — NOT MET for the same reason, same partial-confirmation shape delivered instead (`.SYNTHETIC.` fixtures, sourced from live-researched current Gemini documentation, gaps named in `fixtures/provider-breadth/gemini/manifest.json`).
- AC3: The extracted compat engine is a distinct, separately-testable module; `ollama-provider.test.ts` and every other file touching `OllamaProvider` today (`select.ts`, `select.test.ts`, `providers.ts`, `make-provider.ts`, `make-provider.test.ts`, `guard.loopback.test.ts`) either passes unchanged in outcome or has its changes reviewed as deliberate, not incidental.
- AC4: Both new adapters enforce the same SSRF/egress guard (`isPrivateEgressHost`/`isLoopbackHost`) as the existing two adapters, verified by a test analogous to `guard.loopback.test.ts`.
- AC5: `describe()` on both new adapters is verified against the live-researched vendor documentation for every capability claimed `true` (per plan.md's capability matrix) — an unconfirmed or undocumented capability is declared `false`, not guessed `true`.
- AC6: No vendor SDK dependency is added — verified by import audit, the same way `AnthropicProvider`/`OllamaProvider`'s own "no new dependency" claim is verified.

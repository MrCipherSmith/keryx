# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The OpenAI-compatible adapter's capability grant gains an OPTIONAL `apiKey` (and optional extra `headers`); when `apiKey` is a non-empty string the outgoing `POST /v1/chat/completions` request includes an `Authorization: Bearer <apiKey>` header (plus any provided extra headers); when `apiKey` is absent the request headers are UNCHANGED from today (existing local-ollama behavior byte-identical). The key is never logged/echoed. Unit tests (injected fetch capturing the request init) assert: header present with the exact `Bearer <key>` when apiKey set, and NO Authorization header when absent.
- AC2: `make-provider` handles `name === "openrouter"`: with a non-empty `OPENROUTER_API_KEY` from `opts.env` it constructs the OpenAI-compatible adapter with `baseUrl = https://openrouter.ai/api` and the api key; with an absent/empty key it returns an offline `FakeProvider` (fail-closed — never constructs a network provider, never fetches), mirroring the anthropic-no-key path. `ollama`/`anthropic`/`fake` construction is unchanged. Unit tests cover the key-set and key-absent branches.
- AC3: `detectProviders` (src/commands/select.ts) includes an `openrouter` provider entry when `OPENROUTER_API_KEY` is present in the injected env (with a small static recommended model list, e.g. including `openai/gpt-4o-mini`), and omits it otherwise; it never fetches for openrouter and never throws. `keryx shell --provider openrouter --model <m>` routes through make-provider to the OpenRouter-configured adapter. Unit test asserts openrouter present iff the key is set.
- AC4: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1446 pass / 3 skip / 0 fail with new tests green and 0 fail; the entire suite runs OFFLINE (injected fetch/env; no live network); `dependencies` REMAINS `{}`; the local-ollama and anthropic/fake paths, and the chat/agent cores, are unchanged; the OPENROUTER_API_KEY is read from env only and never stored/logged.

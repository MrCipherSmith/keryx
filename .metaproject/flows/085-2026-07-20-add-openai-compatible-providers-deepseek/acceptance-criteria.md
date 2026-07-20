# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A single provider registry (`src/commands/providers.ts`, `OPENAI_COMPAT_PROVIDERS`) is the source of truth for OpenAI-compatible providers — each entry has `name`, `label`, `baseUrl`, `envKey`, optional `chatPath`/`modelsPath`, curated `models`, `note`. It includes openrouter, deepseek, zai (`api.z.ai/api/paas/v4`, path overrides), zai-coding (`…/api/coding/paas/v4`), cerebras, groq, moonshot with verified base URLs + env vars.
- AC2: `detectProviders` ALWAYS offers every registry provider (carrying `baseUrl`/`envKey`/paths/`label`/`note`); no key is ever placed on the returned shape. `makeProvider` constructs any registry provider via the OpenAI-compat adapter using `env[envKey]` (fail-closed to `FakeProvider` without a key) and passes the provider's `chatPath`. The adapter (`OllamaProvider`) honours a `chatPath` grant (default `/v1/chat/completions`) so Z.AI's `…/paas/v4/chat/completions` works.
- AC3: The in-TUI picker offers all providers (labels + notes), fetches each provider's LIVE `/models` list via `fetchOpenAiCompatModels` (filterable by name, Bearer sent when a key is known; curated fallback on failure), and prompts + persists a missing key per-provider. Keys persist under `apiKeys[envKey]` (0600); `applySavedApiKeys` loads them into env at startup without overwriting an existing env var and migrates the legacy `openrouterKey`. `/model` + `/connect` use the same path.
- AC4: `bunx tsc --noEmit` clean; `bun test` green (1528 pass, +13; no regression from 1515). No new dependency; zero-`dependencies` floor + `@opentui/core` optional/dynamic-import preserved; keys never logged. New providers usable end-to-end (key entry → chat) verified by the user on a real terminal.

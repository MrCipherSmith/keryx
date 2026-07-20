# Implementation Plan

Status: done

## Approach

Extract an OpenAI-compat provider registry and drive detect/make-provider/picker/
config from it. Add a `chatPath` override to the adapter for Z.AI's versioned
endpoint. Generalize the OpenRouter-specific model fetch + single-key persistence
to any provider.

## Steps

1. `providers.ts` registry + `fetchOpenAiCompatModels` + `providerByName`. [done]
2. `select.ts`: widen `DetectedProvider`; `detectProviders` loops the registry;
   `fetchOpenRouterModels` becomes a thin wrapper. [done]
3. Adapter `chatPath` grant; `make-provider` constructs any registry provider. [done]
4. `shell-config`: `apiKeys` map + `saveApiKey` + `applySavedApiKeys` (migrate
   `openrouterKey`, env wins); `shell.ts` applies all saved keys. [done]
5. Picker: labels/notes, live models per provider, per-provider key prompt +
   persist; `/model` + `/connect` reuse it. [done]
6. Tests (registry, fetch, detect, make-provider, config) + full suite green. [done]

## Risks

- Path drift per provider → per-provider `chatPath`/`modelsPath` overrides + tests.
- `/models` needing auth before key entry → Bearer sent when known, curated fallback.

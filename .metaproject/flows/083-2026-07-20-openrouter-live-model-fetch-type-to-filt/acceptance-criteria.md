# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `fetchOpenRouterModels(fetchFn)` in `src/commands/select.ts` does GET `${OPENROUTER_BASE_URL}/v1/models`, parses `data[].id`, returns a deduped + sorted list, and falls back to the curated `OPENROUTER_MODELS` on non-2xx / throw / malformed. Covered by unit tests (ok / 500 / throw).
- AC2: `pickModelInTui` is a type-to-filter overlay: SelectRenderable owns up/down/Enter focus, printable keys build a case-insensitive `includes` filter (e.g. `free`), Backspace edits it, Esc cancels; the filter line shows `filter: X (count)` and `(no match)` resolves `undefined`. Absolute overlay, removed on selection/cancel.
- AC3: The provider->model picker (`selectProviderModelInTui`) and `/model` fetch the LIVE OpenRouter list via `fetchOpenRouterModels(globalThis.fetch)` when the provider is `openrouter`; other providers keep their detected static list. OpenRouter without a key still prompts + persists (0600) after the model choice.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1514 pass). No new dependency (zero-`dependencies` floor + `@opentui/core` optional/dynamic-import preserved). Live fetch + filter validated by the user on a real terminal.

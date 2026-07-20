# Implementation Plan

Status: ready

## Approach

Add a pure `fetchOpenRouterModels(fetchFn)` in `select.ts` (injectable `fetch`
for testability, curated-list fallback). Rewrite `pickModelInTui` into a
type-to-filter overlay (SelectRenderable keeps ↑/↓/Enter; an internal keypress
handler intercepts printable/Backspace/Esc for the filter). Wire the live fetch
into both `selectProviderModelInTui` and the `/model` handler for `openrouter`.

## Steps

1. `fetchOpenRouterModels` + unit tests (ok / 500 / throw). [done]
2. `pickModelInTui` type-to-filter overlay + `overlayBox`/`promptOpenRouterKey`
   helpers; refactor `selectProviderModelInTui` to fetch live models for
   OpenRouter then use the filterable picker. [done]
3. `/model` fetches live OpenRouter models before `pickModelInTui`. [done]
4. Verify: tsc clean, full suite green (no baseline regression). [done]

## Risks

- Network failure / API shape drift → mitigated by try/catch + curated fallback.
- Keypress handler stealing keys from the Input → picker owns the terminal while
  open (absolute overlay), handler removed on cleanup.

# OpenRouter live model fetch + type-to-filter model picker

Status: formalized
Source: user description

## Problem

The provider picker and `/model` showed only a static, curated OpenRouter model
list. OpenRouter hosts hundreds of models (including free ones) and the set
changes over time; users could not reach a model that wasn't hard-coded, and had
no way to search a long list by name.

## Expected Outcome

- Choosing OpenRouter (at startup, via `/connect`, or via `/model`) fetches the
  live model catalog from the OpenRouter API, deduped + sorted, with a resilient
  fallback to the curated list on any error.
- The model picker supports type-to-filter: type part of a name (e.g. `free`) to
  narrow the list live, Backspace to edit, Esc to cancel; up/down/Enter select.
- OpenRouter-without-a-key still prompts for and persists the key (0600).

## Out of Scope

- Provider-list search (only 2-3 providers; no filter needed).
- Caching the fetched model list across launches.
- Changing detected static lists for non-OpenRouter providers.

# Provider picker showed only 1 of N providers

Status: formalized
Source: user bug report (screenshot: only `openrouter` listed, expected 3)

## Problem

In the `--tui` provider picker only the first provider (openrouter) rendered,
even though `detectProviders` returns several (openrouter + fake, plus ollama /
anthropic when available). Root cause: OpenTUI's `SelectRenderable` renders an
item with a description across 2 rows (`linesPerItem = 2`) and computes
`maxVisibleItems = floor(height / linesPerItem)`. The picker set
`height = detected.length` (1 row/item), so `floor(N / 2)` items showed — 1 for
2 providers. The model picker was unaffected (`showDescription: false`, 1 row).

## Expected Outcome

- All detected providers are visible in the picker.
- Height accounting for the 2-row described items is a pure, tested helper so the
  bug cannot silently regress.

## Out of Scope

- Changing what `detectProviders` returns.
- The filterable model picker (already correct).

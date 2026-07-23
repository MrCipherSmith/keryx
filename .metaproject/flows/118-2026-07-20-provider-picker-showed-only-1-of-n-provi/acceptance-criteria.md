# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Root cause — OpenTUI `SelectRenderable` renders described items across 2 rows (`linesPerItem = 2`, `maxVisibleItems = floor(height / linesPerItem)`); the provider picker showed descriptions but was sized `height = detected.length`, so only `floor(N/2)` (== 1 for 2 providers) were visible.
- AC2: New pure exported `selectBoxHeight(count, withDescription, max=16)` returns `min(max, max(per, count*per))` where `per = withDescription ? 2 : 1`, guaranteeing `floor(height/per) >= count` for all `count`; capped at `max` so long lists scroll; never returns 0.
- AC3: The provider picker in `selectProviderModelInTui` uses `selectBoxHeight(detected.length, true)` and shows `showScrollIndicator`; ALL detected providers (openrouter, fake, + ollama/anthropic when present) are now visible. The filterable model picker (`showDescription:false`) is unchanged.
- AC4: `bunx tsc --noEmit` clean; `bun test` green (1515 pass, +1 for `selectBoxHeight`, no regression). No new dependency. Full provider list visible verified by the user on a real terminal.

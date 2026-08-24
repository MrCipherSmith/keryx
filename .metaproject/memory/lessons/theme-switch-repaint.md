# Theme switch repaints already-rendered chrome via old-slot value matching

Version: 0.2.0
Type: lesson
Status: accepted
Confidence: high

Recorded-At: 2026-08-24
## Summary

`/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but
`applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN
surfaces (renderer background, sidebar border, docks, composer, `/`-menu).
Every renderable painted EARLIER with `getTheme()` — transcript frames (user
echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored
block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar
panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg`
props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did
not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript,
docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose
color equals an OLD theme slot hex to the NEW slot hex.

## Details

OpenTUI stores colors as parsed RGBA objects, not the hex strings written to
the setters: `borderColor`/`backgroundColor`/`fg` getters return an object
with `toInts()`. A naive string-match walk finds nothing. Normalize with
`themeColorToHex()` (exported from src/tui/shell-chrome.ts): a string
matching `#rrggbb`, or an object with `toInts()` returning alpha 255, becomes
a lowercase `#rrggbb` for the slot lookup.

- `themeColorRemap(from, to)`: hex map over every theme slot that actually
  changed (skips `name`).
- `recolorThemeTree(node, remap)`: recurse `getChildren()`, reassign props
  whose hex maps to a new slot color (idempotent — a second pass with the
  same map finds nothing).
- Wired into `applyTheme` before the explicit chrome assignments; the walk
  is deliberately scoped to direct container references and skips styled
  CHUNKS inside `content` (dim/bold/cyan/green/red), so hardcoded OpenTUI
  ANSI colors are untouched by design.

Verified headlessly: with a user echo, a code-segment frame and a `tone: red`
tool-block header painted under groknight, `applyThemeId("grokday")` moved
every one of their border/background/fg hexes to grokday slots and left no
groknight slot anywhere under the transcript. Regression test:
"a theme switch repaints every theme-colored renderable in place" in
src/tui/shell-chrome.test.ts. Full src/tui suite: 537 pass / 0 fail.

Known edge, not covered: an OPEN modal at switch time (review-inspector,
games) repaints only its backdrop/panel via modal-host's own onThemeChange;
its tab bodies re-color on next open.

## Provenance

- Source: manual
- Link:
- Created: 2026-08-24
- Updated: 2026-08-24

## Related Scopes

- Module: src/tui
- Entity: shell-chrome.ts
- Files: src/tui/shell-chrome.ts, src/tui/shell-chrome.test.ts
- Skills:

## Tags
## Provenance

- Source: manual
- Link:
- Created: 2026-08-24
- Updated: 2026-08-24

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

## Changelog

- Lifecycle: draft -> accepted on 2026-08-24: Verified by headless renderer test; src/tui suite 537 pass.
- 0.1.0 - Initial version.

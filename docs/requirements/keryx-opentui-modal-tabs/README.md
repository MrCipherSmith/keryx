# Keryx OpenTUI Modal and Tabs
Version: 0.1.0

## Purpose

Define a reusable **modal + tab strip** presentation layer for the OpenTUI
shell. Grok Build's pager treats `/hooks`, `/plugins`, `/marketplace`, and
`/skills` as one modal opened on different tabs; `/session-info` and `/model`
are the same class of overlay. Keryx today only has full-screen
`overlayBox` pickers. This package is the shared chrome those surfaces should
share before any one feature is built.

## Status

`implemented` · reusable `openModal` host in `src/tui/modal-host.ts`. No user-facing slash command.

## Document index

- [Product requirements](prd.md)
- [Technical specification](specification.md)

## Scope

- A reusable modal host: dimmed backdrop, titled panel, focus trap, Esc
  dismiss, `overlayActive` integration.
- A reusable tab strip: named tabs, initial-tab open, Left/Right (and
  optional number keys), content region owned by the caller.
- A first-class host API so `/session-info` and a later `/model` picker can
  share chrome without copying `overlayBox` + `SelectRenderable` wiring.
- Headless tests that do not require a live TTY.

## Non-goals

- Implementing `/session-info` (sibling requirements package; follow-up flow).
- Rewriting `selectProviderModelInTui` in this package (a later consumer).
- Mouse-only UX; click-to-copy; settings/extensions catalogs.
- Changing the readline fallback.
- New npm dependencies beyond the existing optional `@opentui/core`.

## Related modules

- [Keryx OpenTUI Interactive Shell](../keryx-opentui-shell/README.md) —
  existing chrome, `/`-menu, `withOverlay`.
- Session info — first feature consumer (follow-up flow; not in this package).
- Code: `src/tui/shell-chrome.ts`, `src/tui/tui-shell.ts` (`overlayBox`,
  `selectProviderModelInTui`), `src/tui/composer-choice.ts`.

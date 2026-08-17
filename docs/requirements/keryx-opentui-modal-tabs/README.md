# Keryx OpenTUI Modal and Tabs
Version: 0.1.1

## Purpose

Define a reusable **modal + tab strip** presentation layer for the OpenTUI
shell. Grok Build's pager treats `/hooks`, `/plugins`, `/marketplace`, and
`/skills` as one modal opened on different tabs; `/status` and `/model`
are the same class of overlay. This package is the shared chrome those
surfaces share. Shipped callers: `/status` and `/flows`.

## Status

`implemented` · reusable `openModal` host in `src/tui/modal-host.ts`. No slash command of its own; `/status` and `/flows` are callers.

## Document index

- [Product requirements](prd.md)
- [Technical specification](specification.md)

## Scope

- A reusable modal host: dimmed backdrop, titled panel, focus trap, Esc
  dismiss, `overlayActive` integration.
- A reusable tab strip: named tabs, initial-tab open, Left/Right (and
  optional number keys), content region owned by the caller.
- A first-class host API so `/status`, `/flows`, and a later `/model` picker can
  share chrome without copying `overlayBox` + `SelectRenderable` wiring.
- Headless tests that do not require a live TTY.

## Non-goals

- Implementing `/status` or `/flows` (sibling / operator surface; callers).
- Rewriting `selectProviderModelInTui` in this package (a later consumer).
- Mouse-only UX; click-to-copy; settings/extensions catalogs.
- Changing the readline fallback.
- New npm dependencies beyond the existing optional `@opentui/core`.

## Related modules

- [Keryx OpenTUI Interactive Shell](../keryx-opentui-shell/README.md) —
  existing chrome, `/`-menu, `withOverlay`.
- [Session info](../keryx-opentui-session-info/README.md) — `/status` caller.
- `/flows` — second caller (`src/tui/flow-inspector.ts`).
- Code: `src/tui/modal-host.ts`, `src/tui/shell-chrome.ts`, `src/tui/tui-shell.ts`.

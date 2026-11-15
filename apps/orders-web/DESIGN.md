# orders-web design

Warm, editorial, low-chrome. The tone is a paper ledger, not a dashboard kit.

## Palette

| Role | Token | Value |
|---|---|---|
| Text | `ink` | `#1f2933` |
| Page | `paper` | `#fbf8f3` |
| Panels | `surface` | `#ffffff` |
| Rules and borders | `line` | `#ddd6ca` |
| Secondary text | `muted` | `#566170` |
| Brand accent, primary actions | `accent` | `#a63f27` (terracotta) |
| Positive state | `sage` | `#2f5d50` |
| Destructive and errors | `danger` | `#b42318` |

Use the tokens through the Tailwind names (`bg-accent`, `text-muted`). The default
Tailwind palette (indigo, blue, purple, gray scales) is not part of this system.
Text on `paper` or `surface` must reach 4.5:1; `muted` and `ink` do, `line` does not
and is for borders only.

## Type

| Role | Face | Where |
|---|---|---|
| Display | Fraunces | page titles and section headings (`font-display`) |
| Body and UI | Inter | everything else (`font-sans`) |

Exemption: Inter is the body face on purpose. It sits next to a distinct display
face, so it is not the single-default-font look this file rules out for headings.

Scale: 14 / 16 / 20 / 28 / 40 px. Headings use `font-display`, never Inter.

## Shape and depth

- Controls use `rounded-control` (4px), panels `rounded-panel` (10px).
- Panels are separated by a 1px `line` border; shadows are reserved for overlays.
- A panel never sits inside another panel.

## Layout

Supported widths: 320 px and up, in every locale (`en`, `de`, `ar`). The app is
logical-property first (`ps-*`, `me-*`, `start-0`) so right-to-left needs no
second stylesheet. Targets are at least 44 x 44 px on touch widths.

## Copy

Plain, specific, first-person-plural at most. Buttons name the action they run
("Save order", "Export orders"). No claims about customers, volumes or uptime
unless the figure comes from the product's own data.

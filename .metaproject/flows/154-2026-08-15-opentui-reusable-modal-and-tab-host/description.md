# OpenTUI reusable modal and tab host

Status: ready to freeze
Source: docs/requirements/keryx-opentui-modal-tabs/

## Problem

Keryx TUI overlays are one-off full-screen `overlayBox` pickers. There is no
shared modal chrome or tab strip, so `/session-info` and a later model picker
would each copy backdrop, Esc, and `overlayActive` wiring.

## Expected Outcome

A reusable `openModal` host under `src/tui/` that paints a panel + backdrop,
supports tabs, traps focus, dismisses on Esc, and registers with
`shell-chrome` overlay guard. Headless tests pass. No user-facing slash
command in this flow.

## Out of Scope

`/session-info`, migrating `selectProviderModelInTui`, mouse/drag copy,
readline changes, new npm dependencies.

# TUI: interactive picker for /search-connect (mirror /connect's onlyConnected pattern)

Status: formalized
Source: user description (session), grounded in direct code reading

## Problem

Flow 179 shipped a 3-step interactive wizard for bare `/search-provider`, but
deliberately left `/search-connect` untouched (AC3, out of scope) — it still
just prints a static text list of connected providers via
`describeSearchProviderList` (`tui-shell.ts:3947-3982`) and requires the user
to type `/search-connect <id>` as a second command. The user now wants
`/search-connect` (bare, no id) to be interactive, matching the existing
`/connect` convention already in the same file: `/connect` bare opens
`chrome.withOverlay(() => selectProviderModelInTui(otui, r, detected, {
onlyConnected: true, env: process.env }))` — a `SelectRenderable` picker
scoped to only-connected candidates (`tui-shell.ts:4110-4127`).

## Expected Outcome

Typing `/search-connect` with no arguments in the TUI opens a single-step
overlay picker (one `SelectRenderable`, same `overlayBox`/`onKeypress`
primitives already used throughout this file) listing exactly
`searchProviderController.selectable()` (already-connected providers).
Selecting one calls `controller.select(id)` (the exact same call the current
text path already makes) and confirms; Esc cancels with no state mutation.
If `selectable()` is empty, show the existing "No connected search providers
found. Run /search-provider first." message instead of opening an empty
picker (mirrors `/connect`'s own empty-list handling via
`chrome.showToast(...)`).

`/search-connect <id>` (called with an explicit id) is UNCHANGED — keeps
working exactly as it does today, no regression.

## Out of Scope

- `/search-provider` (already interactive since flow 179) — not touched here.
- Any change to `SearchProviderController`, `SandboxedWebTransport`, or
  `web-policy.ts`.
- The plain readline shell (`src/commands/shell.ts`) — TUI only.

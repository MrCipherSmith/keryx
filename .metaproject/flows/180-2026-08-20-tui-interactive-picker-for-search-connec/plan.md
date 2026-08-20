# Implementation Plan

Status: formalized

## Approach

Mirror `/connect`'s exact shape (`tui-shell.ts:4110-4127`): a single
`chrome.withOverlay(() => ...)` call wrapping one `SelectRenderable` picker
scoped to already-connected candidates. This is simpler than flow 179's
3-step wizard — one step, reusing the existing `pickSearchProviderStep`
shape (from flow 179) but filtered to `controller.selectable()` instead of
`controller.configurable()`, and resolving straight to a `select()` call
instead of a further sub-wizard.

Rejected: building a new generic "provider picker" abstraction shared
between `/connect` and `/search-connect` — bigger refactor than this ask,
not requested, would touch code outside this flow's scope
(`selectProviderModelInTui`).

## Steps

1. Add `pickConnectedSearchProviderStep(otui, r, controller)` (or reuse/adapt
   flow 179's `pickSearchProviderStep` with a `providers` param instead of
   calling `configurable()` internally, whichever is the smaller diff) —
   lists `controller.selectable()`; Esc resolves `undefined`.
2. In the `/search-connect` bare-arg branch (`tui-shell.ts:3947-3959`,
   currently `describeSearchProviderList` + early return): if
   `selectable().length === 0`, keep the existing "No connected search
   providers found..." message (no picker for an empty list, matching
   `/connect`'s `chrome.showToast` empty-state). Otherwise open the picker
   via `chrome.withOverlay`; on a selection, call the SAME `controller.select`
   + success/failure message branches the args-given path already has
   (extract that into a shared helper if it avoids duplicating the 3
   result-branches, or call through the same code path — implementer's call
   on the smaller diff).
3. `/search-connect <id>` (args given) stays untouched.

## Risks

- `describeSearchProviderList`'s "(use /search-connect <id> to select)" hint
  text becomes misleading once bare invocation opens a picker instead —
  update the copy if that message is still reachable anywhere (e.g. from
  `/search-provider`'s own success message pointing at `/search-connect`).
- Keep the empty-list case a plain message, not an empty `SelectRenderable`
  (matches `/connect`'s convention, avoids a confusing 0-option picker).

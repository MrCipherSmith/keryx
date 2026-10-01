# Implementation Plan

Status: ready

Depends on flow 373 (`/external-agents on|off` writer) being merged first; start this flow's worktree from the 0.3.44 main.

## Approach

A pure row model plus a thin modal, reusing existing handlers.

## Steps

1. New `src/tui/settings-model.ts`: pure list of rows `{ id, group, label, value, scope: session|saved|restart, actions[] }` built from a plain state snapshot; its own unit test. Groups: Safety (permission mode, plan, turn guard, edit guard), Routing (classifier, external Jev privacy, reasoning effort), External agents, Display (think display, theme, Jev keys).
2. Export `smallActionButton` from tui-shell.ts; build the modal from `openModal`, following `pickConnectedProviderStep` (rows, arrow navigation, Enter, two-step for `auto`).
3. Extract the `/reasoning` and `/think` branches into callable handlers so buttons and commands share them.
4. Register `/settings` in the slash command registry, the help groups, the composer menu; readline `/settings` prints the table from the same model.
5. Sidebar entry or hint pointing at `/settings`.
6. Docs: README and docs site, `commands-by-task`, CHANGELOG 0.3.45, version bump.

## Risks

- Snapshot drift: a row shows a stale value after a button press: rebuild the model after every action (test).
- Restart-only or env/project-overridden settings must show their effective value and scope, not the stored one.
- `auto` must never be reachable with one keypress.

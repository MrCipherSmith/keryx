# Implementation Plan

Status: ready

## Approach

One pure helper in `src/flow` reads git (read-only: `git ls-files` for the flow directory, `git status --porcelain -- <dir>`), returns a note or null, and swallows every git failure into null. `flow complete` (after the completion result is printed) and `flow status <id>` for done flows print it. The TUI reaches it through the same function wherever it already prints those results. The exit code never depends on it.

Flow 359: commit the CLI-written state as is. It is a mechanical commit of files the CLI produced; no edit.

G1a: text change only in two documents of the product-module package. Authorship is classified by hand when the ten flows are read, because flow.json does not record it and adding a field would be a scope change.

## Steps

1. Helper + tests; wire into `flow complete` and `flow status`.
2. TUI check (criterion AC4).
3. Docs: G1a text, CLI reference, CHANGELOG 0.3.32, version.
4. Commit the 359 state.
5. Review, CI, merge, release, install, smoke (`keryx flow status 359` shows no note after the merge is pulled).
6. Stop; ask the operator about W1.

## Risks

- The note appears for every tracked closed flow with dirty state, which is the purpose; untracked flows stay silent so the standing local-flows rule is not nagged.
- `flow complete` runs from the operator's checkout; the note must not shell out slowly on a huge repo: one scoped `git status -- <dir>`.

# TUI busy-branch allowlist: /expand /think /copy /workspace /review

Status: formalized (flow-orchestrator, 2026-08-19)
Source: docs/requirements/keryx-tui-busy-command-allowlist/ (README.md, prd.md, trd.md)

## Problem

While the main TUI agent turn is running, `runLine`'s busy branch
(`src/tui/tui-shell.ts:3019-3097`, inside `runLine` starting at `3006`)
explicitly handles only 6 of the 24 registered slash commands (`/exit`,
`/help`, `/interrupt`, `/queue`, `/status`, `/flows`). Every other command,
including five that are provably safe to run concurrently with an in-flight
turn, is refused with a generic "main is busy — command deferred" message.
This is inconsistent: the `Ctrl+O` keyboard path that does the same thing as
`/expand`/`/think`/`/copy` already runs with **no** busy gate at all
(`createBlockNavController`'s only gate is menu/overlay state,
`tui-shell.ts:1785`), and `/workspace`/`/review` are read-only modals
structurally identical to the already-allowed `/status`/`/flows`.

## Expected Outcome

`runLine`'s busy branch handles `/expand`, `/think`, `/copy`, `/workspace`,
and `/review` the same way it already handles `/status`/`/flows` — dispatch
to the exact same functions the idle path already calls, no new state, no new
architecture. Every command not named here keeps its exact current behavior
(deferred while busy). See `docs/requirements/keryx-tui-busy-command-allowlist/trd.md`
§1.3 for the exact resolved edit shape (three `command?.name` arms + extending
`isBusyReadonlyCommand` + two more arms).

## Out of Scope

- `/new`, `/resume`, `/sessions`, `/compact`, `/model`, or any command not
  named above — stay blocked while busy (existing code comment at
  `tui-shell.ts:3085`: "refuse (avoid racing main session)").
- The collapse/expand mechanism itself (`BlockRegistry`, `createBlockView`,
  `createBlockNavController`) — already correct, not touched.
- Tool-aware/structured diff generation for edit tools — separate, larger
  topic (see README's "Known limitation" section).
- New busy-state UI affordances (e.g. a "these work while busy" hint).
- A new automated test harness for `runLine`'s dispatch — TRD finding: none
  exists today for any of the 24 commands (busy or idle); building one is
  disproportionate to this fix's scope. Verification is manual/smoke plus the
  existing full suite (typecheck + `bun test`).

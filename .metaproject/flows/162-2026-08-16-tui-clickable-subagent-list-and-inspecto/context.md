# Context

Collected deterministically by `keryx flow init` at 2026-08-16T16:01:00.005Z.

## Related Memory

- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height
- [accepted/constraint] Flow ids are allocated per clone, not per checkout

## Existing surfaces

- `src/tui/worker-fleet.ts` — pure fleet registry + `formatFleetSidebar` (truncates).
- `src/tui/subagent-bridge.ts` — `upsert` / `remove` only; no work log.
- `src/harness/tool/builtin/spawn-subagent-tool.ts` — child `AgentIO` keeps
  assistant text locally; fleet upserts on spawn/tool/done; `remove` after 15s.
- `src/tui/modal-host.ts` — reusable overlay (flow 154). Default 72×18.
- `src/tui/session-info.ts` / `src/tui/flow-inspector.ts` — inspector pattern:
  pure formatters + `presentX(openModal, …)`.
- OpenTUI `RenderableOptions.onMouseDown` is available; chrome already sets
  `useMouse: true`.

## Reference (cloned)

`/Users/tsaitler.aleksandr/goodea/misk/grok-build` — tasks pane lists every
subagent; click opens a child view overlay (`docs/user-guide/16-subagents.md`,
`src/views/tasks_pane.rs`).

## Wiki

- `.metaproject/wiki/components/src-tui.md` — fleet is text-only; bridge is
  spawn-only; modal host is the shared overlay.

## Agent Findings

Keryx already has the three pieces this feature composes: fleet state, the
spawn bridge, and `openModal`. The gap is (1) retain every child, (2) record
child IO as a work log, (3) paint clickable rows, (4) present a live inspector.

# TUI: unblock /mode while main is busy

Status: formalized (flow-orchestrator, 2026-08-19)
Source: docs/requirements/keryx-tui-busy-mode-command/ (README.md, prd.md, trd.md)

## Problem

`/mode` (permission-mode switching — `ask`/`trust`/`auto`) is refused with
the generic "main is busy — command deferred" message whenever a main
agent turn is in progress, purely because it was never evaluated for the
busy-branch allowlist added in flow 172 (`classifyBusyDispatch`,
`src/tui/busy-dispatch.ts`) — not because it's genuinely unsafe like
`/new`/`/resume`/`/sessions`/`/compact`/`/model`. The tool-call approval
gate (`resolveApprovalDecision()` via `agent.ts:1985`, inside
`executeCall()`) already reads the permission mode fresh on every
individual tool call, not once per turn, so a mid-turn `/mode auto` would
already take effect on the running turn's next not-yet-gated tool call — if
only the busy branch let the command reach its handler at all.

## Expected Outcome

`runLine`'s busy branch handles `/mode <ask|trust|auto>`, `/mode clear`,
and `/mode` (no-arg picker) — all three forms via one hoisted
`runModeCommand(line)` function, extracted verbatim from `/mode`'s current
inline idle-path block (`tui-shell.ts:3569-3644`) and called from both the
idle path and a new `case "mode":` in the busy switch. `classifyBusyDispatch`
(`src/tui/busy-dispatch.ts`) gains one new `"mode"` target. See
`docs/requirements/keryx-tui-busy-mode-command/trd.md` §1.2-§1.3 for the
exact resolved shape.

## Out of Scope

- No changes to `/new`, `/resume`, `/sessions`, `/compact`, `/model`, or any
  other command not named above — they stay blocked while busy.
- No change to `permission-mode.ts`'s decision logic, `PermissionMode`'s
  type, or `agent.ts`'s gate/read path — confirmed by investigation that
  neither needs to change.
- No new overlay/UI chrome — reuse `/mode`'s existing overlay calls
  verbatim, only make them reachable while busy.
- No change to the `auto`-confirmation overlay's copy/behavior.

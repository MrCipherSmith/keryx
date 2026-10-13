# Remote control review residuals: approval frame ack and TUI call-site tests

Status: draft (operator reviews PRD and AC before freeze)
Source: flow 376 review rounds 2026-10-01-ingest-817 and 2026-10-02-ingest-817-r02 (origin: agent-finding)

## Problem

Both review rounds of flow 376 (remote control, 0.3.48) hold the same 16 findings (F-001..F-016). The
second round was ingested at head b55951eb with each finding's disposition already filled in. Checked
against main at 6b8cabb6 (0.3.64): 15 are fixed (commit 4f1326d2, with bbfaa901 hardening F-001
further) and F-011 was dismissed by the operator (AC5 reworded, poll 25). Targeted tests pass on main
(110 tests in review-fixes, shell-bridge, poll-lock, main-queue, help-groups, serve-proof).

Two residuals that the reviews themselves recorded are still open:

1. F-004: serve says "Allowed by user N" the moment `stream.write` returns true. The shell does not
   acknowledge approval frames, so a write into a half-open socket is still announced as granted while
   the shell times out and denies. Execution fails closed, but the operator is told the wrong outcome.
   The approval message now carries the final state in place (flow 387), which makes the wrong text
   more visible than before.
2. F-010, F-014, F-015, F-016: the fixes live in the pure helpers (main-queue.ts, shell-bridge.ts) and
   those are tested, but the call sites inside `src/tui/tui-shell.ts` (`editMainQueue`,
   `removeMainQueue`, `stopRemoteForSessionSwitch`, the `onToolCall` wrapper) are confirmed by reading
   only. Deleting one call leaves every test green.

## Expected Outcome

An approval decision is announced only as far as it is known to have arrived, and each shell call site
that the 376 fixes depend on is held by a test that fails when the call is removed.

## Outcome criteria

- Источник: F-004 "The topic is told 'Approval granted.' even when the decision may never reach the shell: the boolean result of stream.write was ignored and no ack exists for approval frames" (suggested fix: "better, let the shell acknowledge the approval frame"); F-010/F-014/F-015/F-016 dispositions: "The shell call sites are confirmed by reading, not by a TUI-level test."
- Эффект (формализация агента): a Telegram approval press ends as "Allowed" or "Denied" only after the shell has acknowledged the frame, otherwise as "sent, not confirmed"; and the shell wiring for editing, removing, switching session away from, and narrating a Telegram line is exercised by tests that go red when a call site is deleted.
- Как наблюдать (предложение агента): press Allow in a topic with the shell stream paused: the message reads "not confirmed" instead of "Allowed", and the shell's transcript shows the decision line when it does arrive; `bun test` on the new wiring tests fails when any one of the four call sites is removed.

## Out of Scope

- Unix domain socket for the shell/serve surface (F-001's first suggestion). The mutual HMAC proof
  (bbfaa901) means the raw token no longer leaves the shell, so the residual is small.
- Real Telegram Bot API behaviour for F-002 (the fake Bot API is the only coverage; needs a live bot and
  the operator's OK, per the supervisor rules).
- F-011 (dismissed by the operator, AC5 reworded).

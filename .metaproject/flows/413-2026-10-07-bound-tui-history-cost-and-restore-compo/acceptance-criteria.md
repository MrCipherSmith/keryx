# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Closing a busy-agent routing choice restores usable composer keyboard focus unless a newer focus or modal owns it; cover submit, cancel, abort and nesting with real-renderer tests.
- AC2: Completed transcript history has a bounded mounted window independent of total message count; streaming/current/protected nodes remain live and archived conversation data is not deleted.
- AC3: Repeat PTY streaming measurements at 0, 100, 500, 1000, 2000 and 4000 messages, report mounted-node counts and median/p95 key-to-frame latency, and verify no lost input probes and usable input after busy submission.
- AC4: Focused regressions, type checks and independent review pass; record limitations and all remaining findings.
- AC5: Deliver only in fix/tui-input-latency worktree without merge or push; retain flow in-progress for verified handoff.

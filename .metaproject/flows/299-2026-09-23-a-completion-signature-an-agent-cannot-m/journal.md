# Flow Journal

- 2026-09-23T05:23:59.298Z - flow created
- 2026-09-23T05:31:42.622Z - frozen: 9 criteria; checksum recorded
- 2026-09-23T05:31:42.734Z - started
- 2026-09-23T05:31:42.854Z - task-added: T5: flow never left in completing: fix the failure paths at the source
- 2026-09-23T05:31:42.971Z - task-added: T6: flow recover
- 2026-09-23T05:31:43.089Z - task-added: T7: flow confirm terminal token, opt-in confirmation gate, signature confirmation field
- 2026-09-23T05:31:43.206Z - task-added: T8: No agent path mints or bypasses the token; floor and approval markers
- 2026-09-23T05:31:43.322Z - task-added: T9: Backward compatibility sweep, TM-03 decision record and CLI reference limits
- 2026-09-23T05:31:43.436Z - task-added: T10: Verification: CI green, keryx health run
- 2026-09-23T05:31:43.556Z - task-attempt: T5: started (attempt 1)

- 2026-09-23T06:00:00Z - phase-2 implementation (T5-T9), by the implementing agent:
  - T5 (AC5): complete() no longer leaves `completing`. The merge, pull-request and base-branch gates are caught and recorded as unevaluable. The failure path uses returnToInProgress, which skips the criteria re-check. A tamper after a passing attempt is recorded as a second, failed attempt.
  - T6 (AC6): `flow recover <id> --reason`. isCompletionInterrupted and interruptedCompletionLine (store.ts) are shared by `flow status` and the TUI's `/flows` list, detail and session lines.
  - T7 (AC1-AC3): `flow confirm` (TTY and a /dev/tty challenge), confirm-token.ts, an opt-in `confirmation` gate (reported last, evaluated at start), and `signature.confirmation`. Shown in status, the complete note and the governance report.
  - T8 (AC4): touchesFlowConfirm and touchesHumanConfirmation feed the sacReviewConfirmation floor in the agent loop, ACP and codex. The unattended floor forbids `flow confirm` and `flow recover` and protects confirm-token stores.
  - T9 (AC7-AC8): a backward-compat sweep over every repo flow, TM-03, CLI reference limits, a TM-02 §7 update, the SAC guide and README reworded, and a docs test.
  - No command-registry descriptor was added. `flow complete` and `ac confirm` have none either, and a descriptor would make `flow confirm` eligible for remote/MCP projection.
  - Smoke test: a Python pty minted a token with no human present. This is the TM-03 §5 limit 2, reproduced.
  - Checks: touched suites 1166 pass / 0 fail. typecheck clean. eslint clean. `flow check` consistent. AC5 and AC4 tests fail with their fixes reverted (7 and 8 failures) and pass when the fixes are restored.
- 2026-09-23T05:55:41.811Z - task-done: T5: flow never left in completing: fix the failure paths at the source
- 2026-09-23T05:55:41.947Z - task-done: T6: flow recover
- 2026-09-23T05:55:42.073Z - task-done: T7: flow confirm terminal token, opt-in confirmation gate, signature confirmation field
- 2026-09-23T05:55:42.202Z - task-done: T8: No agent path mints or bypasses the token; floor and approval markers
- 2026-09-23T05:55:42.329Z - task-done: T9: Backward compatibility sweep, TM-03 decision record and CLI reference limits

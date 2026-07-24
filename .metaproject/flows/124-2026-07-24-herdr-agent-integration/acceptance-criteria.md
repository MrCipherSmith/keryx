# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/tui/herdr-report.ts` exports `createHerdrReporter` and `herdrStateFor`; `herdrStateFor` maps `running`→`working`, `blocked`→`blocked`, and `queued`/`done`/`failed`→`idle`.
- AC2: The reporter performs no socket writes unless `HERDR_ENV` equals `1` and both `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` are set; otherwise `report`/`release` are no-ops.
- AC3: When the env gate is satisfied, `report(state)` emits a `pane.report_agent` message with `source` `herdr:keryx`, `agent` `keryx`, the pane id, and the given state; consecutive identical states are deduped; `release()` emits a `pane.release_agent` message.
- AC4: `src/tui/tui-shell.ts` reports the mapped state from within `setMainAgent`, and the `launchTuiAgentShell` `finally` teardown awaits the reporter's `release()`.
- AC5: `bun test src/tui/herdr-report.test.ts` passes and `tsc --noEmit` reports no errors introduced by this change.

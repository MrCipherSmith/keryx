# Flow Journal

- 2026-09-20T09:05:38.537Z - flow created
- 2026-09-20T10:57:03.252Z - frozen: 11 criteria; checksum recorded
- 2026-09-20T10:57:03.338Z - started
- 2026-09-20T10:57:28.849Z - task-done: T1: Collect remaining context
- 2026-09-20T10:57:28.931Z - task-done: T2: Implement per plan
- 2026-09-20T10:57:29.016Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-20T10:57:29.116Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-20T10:57:29.246Z - ac-confirmed: AC1: invariants.test.ts now scans listSourceFiles over src/commands/ + src/mcp-servers/; non-vacuity check retained
- 2026-09-20T10:57:29.342Z - ac-confirmed: AC2: serve.ts:275-276 process.once to process.on; finish() guards with 'if (draining) return' set before any work, verified by reading the closure
- 2026-09-20T10:57:29.428Z - ac-confirmed: AC3: read every production diff myself: shell-approval.ts optional dir pass-through, shell.ts spread-not-undefined fix, tui-shell/bus-wake/boot-animation call-site rewires, new bus-join.ts
- 2026-09-20T10:57:29.514Z - ac-confirmed: AC4: BUS_WAKE_CAPPED_NOTICE exported from bus-wake.ts; the audit is a constant comparison in bus-wake.test.ts
- 2026-09-20T10:57:29.597Z - ac-confirmed: AC5: BusJoinCallbackDeps is all functions (isDestroyed, getDelivered, onLeaseHoldPoll, onBusWakePoll); verified by reading the interface — captured values would read undefined forever
- 2026-09-20T10:57:29.682Z - ac-confirmed: AC6: createSplashLifecycle wired at all 3 tui-shell.ts call sites; isToolAvailableToSideWorker called directly by the last flow-173 F-003 test
- 2026-09-20T10:57:29.770Z - ac-confirmed: AC7: allowShellPattern(pattern, dir?) already existed at shell-permissions.ts:328; the diff stat for src/lib is empty
- 2026-09-20T10:57:29.863Z - ac-confirmed: AC8: manifest regenerated from the live scan: 12 files / 34 sites; shell-source-audits.test.ts green
- 2026-09-20T10:57:30.096Z - ac-confirmed: AC9: decideJoinAdoption row corrected from 4 tests to 1, with why; the other 3 need the separate buildBusJoinOptions/attemptBusJoin seam
- 2026-09-20T10:57:30.354Z - ac-confirmed: AC10: the 'seam each one waits on' section is kept; approval-wiring recorded as needing one owner across both god-files

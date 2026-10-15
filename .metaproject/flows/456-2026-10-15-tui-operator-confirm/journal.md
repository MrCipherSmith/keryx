# Flow Journal

- 2026-10-15T18:08:38.862Z - flow created
- 2026-10-15T18:12:53.829Z - task-done: T1: Collect remaining context
- 2026-10-15T18:12:53.976Z - task-done: T2: Implement per plan
- 2026-10-15T18:12:54.120Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-15T18:12:54.262Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-15T18:12:54.406Z - task-added: T5: Framework: operator-confirm helper, registration, unattended list, TUI card
- 2026-10-15T18:12:54.550Z - task-added: T6: Review gate tools: chunks answer, publish, waive coverage, waive readiness
- 2026-10-15T18:12:54.694Z - task-added: T7: Other gate tools: flow confirm, external apply, learn, schedule actions
- 2026-10-15T18:12:54.841Z - task-added: T8: Redirect refusals, skills and decision record
- 2026-10-15T18:12:54.991Z - task-added: T9: Verify + review round + PR
- 2026-10-15T18:12:55.133Z - task-added: T10: Patch release after merge
- 2026-10-15T18:12:55.288Z - task-added: T11: Owner live check in keryx shell
- 2026-10-15T18:12:55.450Z - frozen: 10 criteria; checksum recorded
- 2026-10-15T18:12:55.595Z - started
- 2026-10-15T18:25:38.854Z - task-done: T5: Framework: operator-confirm helper, registration, unattended list, TUI card
- 2026-10-15T18:31:55.525Z - task-done: T6: Review gate tools: chunks answer, publish, waive coverage, waive readiness
- 2026-10-15T18:37:53.273Z - task-done: T7: Other gate tools: flow confirm, external apply, learn, schedule actions
- 2026-10-15T18:52:51.797Z - ac-updated: AC5: "In a real terminal the existing TTY paths of all eight commands behave exactly as before; without a TTY, and under `KERYX_TOOL_CALL=1`, each refusal names the tool to use instead. Existing command tests stay green and new tests assert the refusal text. · sensitive: revert [verify: exec `bun test src/commands/review-chunks.test.ts src/commands/flow.test.ts src/commands/agents-external-write.test.ts src/commands/learn src/commands/schedule src/commands/review-tty-refusal.test.ts`]" -> "In a real terminal the existing TTY paths of all eight commands behave exactly as before; without a TTY, and under KERYX_TOOL_CALL=1, each refusal names the tool to use instead. Existing command tests stay green and new tests assert the refusal text. · sensitive: revert [verify: exec `bun test src/commands/review-chunks.test.ts src/flow/confirm-token.test.ts src/commands/agents-external-write.test.ts src/commands/learn src/commands/schedule src/commands/review-tty-refusal.test.ts`]" (cited test file src/commands/flow.test.ts does not exist; flow confirm is tested in src/flow/confirm-token.test.ts)

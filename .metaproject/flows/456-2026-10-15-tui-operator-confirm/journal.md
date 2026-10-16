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
- 2026-10-15T18:53:05.105Z - task-done: T8: Redirect refusals, skills and decision record

## 2026-10-15 review round (T9)
Two opus reviewers (security, correctness). No blockers; no path lets a model/mode/child answer a card.
Major: apply not bound to card state for review_publish (target/event), flow_confirm (checksum/target), learn_* (content); schedule decisions unrecorded.
Minor: chunks card writes chunks.json; terminal-pointing refusals in chunks-estimate/confirm-token; signature mislabels card tokens; Yes preselected; remote truncation; review cards unsanitised; nested KERYX_TOOL_CALL only for schedules; TM-04 understates flow_confirm change; stale floor test title; no roster-absence test.
Fix lanes A (review), B (other), C (framework/TUI/remote/docs) dispatched.
- 2026-10-15T19:00:19.298Z - task-attempt: T9: started (attempt 1) — review round 1: 0 blocker, 2 major; fix lanes A/B/C
- 2026-10-15T19:08:25.752Z - task-done: T9: Verify + review round + PR
- 2026-10-15T21:37:03.108Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/1034 (warning: PR is not a draft)

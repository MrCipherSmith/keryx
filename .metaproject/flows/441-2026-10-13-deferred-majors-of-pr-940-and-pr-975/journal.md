# Flow Journal

- 2026-10-13T07:31:12.803Z - flow created
- 2026-10-13T07:31:57.991Z - task-added: T5: R4+R5: parseReviewResult in src/review/ledger.ts, review-slice.test.ts, verify-command repo check (PRD T1)
- 2026-10-13T07:31:58.448Z - task-added: T6: R2+R3: bun test trust rule and path confinement of review slice, retry-plan, dispatch-check (PRD T2)
- 2026-10-13T07:31:58.951Z - task-added: T7: R1: shared drainNext helper for the three queue drain sites in the TUI shell (PRD T3)
- 2026-10-13T07:31:59.424Z - task-added: T8: Replay of closed review rounds' raw files through the new parser; decide differences file by file with the operator (PRD T4)
- 2026-10-13T07:32:03.560Z - task-done: T2: Implement per plan
- 2026-10-13T07:32:04.035Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-13T07:50:52.556Z - frozen: 21 criteria; checksum recorded
- 2026-10-13T08:22:15.329Z - ac-updated: AC13: "`parseReviewResult` on `{"status":"BLOCKED","reviewer":"r","findings":[]}` followed by a trailing `{"status":"DONE"}`, with no `REVIEW_RESULT` marker, returns `undefined` (the two-status case is ambiguous and raises the existing "no parseable REVIEW_RESULT block" gap), never either object; the same two objects with a `REVIEW_RESULT` marker before one of them return the object after the marker (poll 142, 2026-10-13). [verify: judged]" -> "`parseReviewResult` on `{"status":"BLOCKED","reviewer":"r","findings":[]}` followed by a trailing `{"status":"DONE"}`, with no `REVIEW_RESULT` marker, returns `undefined` (the two-status case is ambiguous and raises the existing "no parseable REVIEW_RESULT block" gap), never either object; the same two objects with a `REVIEW_RESULT` marker before one of them return the object after the marker when it passes the AC14 check; a status-only object after a bare marker is rejected under AC14 and is a gap, while the fenced `REVIEW_RESULT` block keeps accepting it (polls 142 and 151, 2026-10-13). [verify: judged]" (Operator poll 151: code follows AC14; AC13 wording clarified so the marker case does not contradict it)

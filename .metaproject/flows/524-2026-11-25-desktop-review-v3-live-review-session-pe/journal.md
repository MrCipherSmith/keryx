# Flow Journal

- 2026-11-25T05:57:50.199Z - flow created
- 2026-11-25T06:03:48.286Z - task-added: T5: Write docs/requirements/keryx-desktop-review-v3
- 2026-11-25T06:03:48.562Z - task-added: T6: Run related suites, typecheck and health
- 2026-11-25T06:03:56.100Z - frozen: 11 criteria; checksum recorded
- 2026-11-25T06:03:56.377Z - started
- 2026-11-25T06:03:56.698Z - task-done: T1: Collect remaining context
- 2026-11-25T06:04:07.713Z - task-done: T5: Write docs/requirements/keryx-desktop-review-v3
- 2026-11-25T06:04:30.344Z - task-attempt: T2: started (attempt 1) — 524-T2 backend+desktop lanes
- 2026-11-25T06:21:05.630Z - task-done: T2: Implement per plan
- 2026-11-25T06:21:05.911Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-25T06:21:06.192Z - task-attempt: T6: started (attempt 1) — verify suites

- 2026-11-25 review round 1 (PR #1317): two reviewers (backend, Desktop). Majors: B-M1 review-id collision merges two PRs; B-M2 paused->ready refused; D-M1 Continue on a v2 attempt has no fallback without review.json. Fix round 1 dispatched for these three only.
- Deferred minors (not fixed per the 2-round cap rule): B-m1 paused loses its step (no pausedFrom); B-m2 review.json write and journal append are not one unit, publish not idempotent; B-m3 unknown errors exit 1 instead of 2, round shape not validated; B-m4 write verbs on a missing id leave an empty dir; B-m5 reused round stays stale; B-m6 skill does not name the base/head source outside Desktop; D-m1 refused board start still switches the shown session; D-m2 load failure reported as busy; D-m3 failed history read clears the v2 badge; D-m4 new review session not linked to the PR's Flow; D-m5 no notice when the user switched sessions during the open; D-m6 DOM test does not prove App continue wiring, no Reviews-tab fixture step. Info items in the reviewers' reports (i1-i7) recorded, no action.
- Operator (via coordinating session): no local test suites; CI is the test signal for this PR and its fix rounds.
- 2026-11-25 review round 2 (final, cap 2): the three round-1 majors are closed; no new blocker or major. Round-2 minors (collision dead end for the second PR, Continue stays enabled after send) deferred.
- 2026-11-25 CI on c290fc508: 18 pass, 8 pending, 1 fail: 'linux sandbox (bubblewrap) live smoke' — src/lib/hub-machine/trial.process.test.ts trial-timeout (hub-machine trial, untouched by this PR; main CI green on ddad229f1). Treated as flaky; the next push re-runs it once.
- 2026-11-25 Completion choice answered by the dispatch brief: Draft PR against main, never merge (merge needs the user's own word). Flow stays in-progress (option C) until the PR is reviewed and merged.
- 2026-11-25T07:12:01.252Z - task-done: T4: Self-review and prepare draft PR
- 2026-11-25T07:12:01.454Z - task-done: T6: Run related suites, typecheck and health

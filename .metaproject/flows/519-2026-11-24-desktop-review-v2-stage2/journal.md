# Flow Journal

- 2026-11-24T07:16:18.886Z - flow created
- 2026-11-24T07:19:14.810Z - task-done: T1: Collect remaining context
- 2026-11-24T07:19:15.191Z - task-done: T2: Implement per plan
- 2026-11-24T07:19:15.510Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-24T07:19:15.823Z - task-done: T4: Self-review and prepare draft PR
- 2026-11-24T07:19:16.212Z - task-added: T5: Store: reviews table, rounds and attempts, migration and its test, badge round with parity
- 2026-11-24T07:19:16.529Z - task-added: T6: Reviews read model, keryx review reviews --json, bridge arg and platform call
- 2026-11-24T07:19:16.834Z - task-added: T7: Reviews tab: navigation, board/list/filters, Review panel with the moved review interface, indicator
- 2026-11-24T07:19:17.196Z - task-added: T8: Pull requests board: indicator without local review, New review round label, F-024
- 2026-11-24T07:19:17.519Z - task-added: T9: Migration on a copy of the local working database
- 2026-11-24T07:19:17.861Z - task-added: T10: Test suites, typecheck and lint
- 2026-11-24T07:19:18.248Z - task-added: T11: Reviews toolbar measurement at 1100/760/560px
- 2026-11-24T07:19:18.561Z - task-added: T12: review-orchestrator on the PR
- 2026-11-24T07:19:18.913Z - task-added: T13: Implementation plan stage 2 state, deviation b closed, CLI reference
- 2026-11-24T07:19:31.529Z - frozen: 12 criteria; checksum recorded
- 2026-11-24T07:19:31.820Z - started
- 2026-11-24T07:19:40.519Z - task-attempt: T5: started (attempt 1) — 519-T5

## 2026-11-24 · T5 accepted (DONE_WITH_CONCERNS)

- Orchestrator re-ran `bun test src/review/desk-run-store.test.ts src/review/board-badges.test.ts` (46 pass, 0 fail) and `bun run typecheck` (clean).
- Concern: `desk-run-store.ts` is 854 lines (over the 800-line readability threshold). Moving the assignment logic to its own module is left as a follow-up.
- Concern: each writable open takes a short immediate lock for the migration check; it is covered by the 8 s busy_timeout.
- Concern: Desktop `badgesEqual` does not compare `outdated.round`. T8 handles this.
- Behaviour, as the plan specifies: a range that comes back after other ranges (A, B, A) rejoins its first round as a retry. A row without `createdAt` sorts first.
- `board-types.ts` touched: `outdated.round?` is required by `LocalBadge`.
- Worker saw `src/review/layers-payload.test.ts` time out under the full `src/review` run. That test does not import the changed files. CI will tell; not verified against base.

## 2026-11-24 · T9 migration on a copy of the local working database

`sqlite3 .backup` copy of `~/.local/share/keryx/desktop-review/runs.sqlite` into the session scratchpad (not committed), opened twice with the new writable store:
attempts before 17 / after 17; unassigned 0; reviews 13 = distinct (repo, pr, lower(viewer)) keys 13; dangling review ids 0; rounds: round 1 x 13, round 2 x 4. The second open changed nothing.
- 2026-11-24T07:37:04.175Z - task-attempt: T6: started (attempt 1) — 519-T6

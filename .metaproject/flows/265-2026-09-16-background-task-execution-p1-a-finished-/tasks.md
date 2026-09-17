# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | test | RED tests for AC1-AC11 (drain exactly-once, message shape and placement, hold, idle wake, cap, resolvers) |
| T6 | implement | Registry: `observed`, `drainUndelivered`, `onCompletion`, `hold-timeout` kill reason (AC1, AC2, AC6) |
| T7 | implement | Agent loop: drain at the round boundary (`agent.ts:1714-1723`) and build the coalesced `<task-notification>` message (AC3, AC4, AC5, AC9) |
| T8 | implement | Agent loop: hold the turn at the text-only finish (`agent.ts:1438`) for `completionDelivery: "hold"` sessions (AC6) |
| T9 | implement | Shells: readline race at `shell.ts:963-969`, TUI idle wake around `runLine` (`tui-shell.ts:4422`), wake cap and reset (AC7, AC8, AC10) |
| T10 | test | Verify: `bun run typecheck`, the P0 regression suites with `--timeout 30000`, and a real `--print` run proving a held turn reports its result (AC11) |
| T11 | review | Review the P1 diff and fix findings |
| T12 | docs | Journal deviations; mark P1 in `docs/requirements/keryx-background-task-execution/` (README, metrics rows M5/M6/M11/M12/M16, PRD S3) |

T1 closed done (context collected while locating the seams); T2-T4 closed
skipped, superseded by T5-T12.

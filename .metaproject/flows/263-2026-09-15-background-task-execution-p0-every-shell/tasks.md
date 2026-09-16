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
| T5 | test | RED tests for AC1-AC8 (registry, shell_exec yield, idle timeout, cap, TUI store) |
| T6 | implement | Registry: task ids, phase, statuses + killReason, waitForExit, promote, idle timer, config resolvers (AC1, AC3, AC4, AC5, AC6) |
| T7 | implement | shell_exec: bounded yield path, schema (`description`, `idle_timeout_ms`), description text (AC1, AC2, AC3, AC5, AC7) |
| T8 | implement | TUI BackgroundJobStore: phase gating and new statuses (AC8) |
| T9 | test | Verify: `bun run typecheck`, AC9 regression suites with `--timeout 30000`, real-process incident smoke through `shell_exec` |
| T10 | review | Review the P0 diff (review-orchestrator) and fix findings |
| T11 | docs | Journal deviations (in-place registry, idle timeout pulled into P0) and update prompt/comment text that still advises `background:true` |

T1 closed done (context collected while checking the requirements package);
T2-T4 closed skipped, superseded by T5-T11.

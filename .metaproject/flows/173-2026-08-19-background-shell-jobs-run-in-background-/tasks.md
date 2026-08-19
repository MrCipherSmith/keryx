# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context — done: prior-art research + existing-architecture grounding, see `context.md` |
| T2 | implement | Both layers per `plan.md`'s Steps 1 & 2: harness (`JobRegistry`, `shell_exec(background:true)`, `shell_job_output`, `shell_job_kill`, concurrency cap, session-exit sweep) AND TUI (`job-bridge.ts`, `background-job-session.ts`, `background-job-inspector.ts`, sidebar wiring in `tui-shell.ts`) |
| T3 | test | Tests for both layers per `acceptance-criteria.md` AC1–AC10 (harness: AC1–AC7, AC10; TUI: AC8–AC9) — TDD-first where practical (tests-creator before task-implementer per layer) |
| T4 | review | review-orchestrator pass (architecture, logic, testing-practices at minimum — this touches the approval/budget-gated tool surface) + fix findings |
| T5 | docs | `wiki/architecture/background-jobs.md`, shaped like `wiki/architecture/permission-modes.md` (Summary/Details/Explicitly-out-of-scope/Related) |

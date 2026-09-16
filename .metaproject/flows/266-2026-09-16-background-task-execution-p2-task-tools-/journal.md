# Flow Journal

- 2026-09-16T13:03:29.197Z - flow created
- 2026-09-16T13:16:03.424Z - frozen: 12 criteria; checksum recorded
- 2026-09-16T13:16:03.525Z - started
- 2026-09-16T13:16:45.648Z - task-added: T5: RED tests for AC1-AC12 across registry, tool surface, agent loop and both shells
- 2026-09-16T13:16:45.751Z - task-added: T6: Tool contract: invoke(input, ctx) and executeCall passes the turn's abort signal
- 2026-09-16T13:16:45.848Z - task-added: T7: shell_task_output with an explicit cursor, plus the observer split on the tool factory
- 2026-09-16T13:16:45.943Z - task-added: T8: shell_task_wait: any/all, the [0,300000] clamp, abort via ctx.signal, never kills
- 2026-09-16T13:16:46.101Z - task-added: T9: shell_task_kill, the two aliases with both id shapes, and their deprecation notes
- 2026-09-16T13:16:46.386Z - task-added: T10: /demote <task_id> in both shells through the shared command registry
- 2026-09-16T13:16:46.628Z - task-added: T11: Side-worker denial over the real roster, and REPEATABLE_TOOL_NAMES
- 2026-09-16T13:16:46.751Z - task-added: T12: Verify: typecheck, named suites, full suite, live abort-does-not-kill smoke, health
- 2026-09-16T13:16:46.869Z - task-added: T13: Review round ingested against the head that will merge
- 2026-09-16T13:16:47.132Z - task-added: T14: Journal deviations and mark P2 in the requirements package
- 2026-09-16T13:17:10.791Z - task-done: T1: Collect remaining context
- 2026-09-16T13:17:10.890Z - task-done: T2: Implement per plan
- 2026-09-16T13:17:10.994Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-16T13:17:11.104Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-16T13:17:11.200Z - task-attempt: T5: started (attempt 1) — RED tests for AC1-AC12: behaviour proven by execution wherever a seam exists; source audits only for the two REPL loops that have none

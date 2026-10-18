# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title | Depends |
|----|------|-------|---------|
| T1 | context | Collect remaining context (done in init: context.md) | |
| T2 | implement | Implement per plan (superseded by T5-T10) | |
| T3 | test | Add/adjust tests and make them pass (superseded: tests ship with each task) | |
| T4 | review | Self-review and prepare draft PR (superseded by T11) | |
| T5 | implement | A: mutate scratch under repo + baseline output on failure (AC1, AC2) | |
| T6 | implement | B: retry-plan --package collects late results, no re-dispatch (AC3) | |
| T7 | implement | C: `review verdict` interim verdict command (AC4) | |
| T8 | implement | D: required --depth light/full/auto, light-round mutation waiver, estimate (AC5-AC7) | |
| T9 | implement | E: dispatch-check paths, required --package, per-subcommand help, start graph timeout (AC8, AC9) | |
| T10 | docs | Skill review-orchestrator: early verdict/verifier, recovery, estimate, light round, host fix, both copies (AC10) | T6,T7,T8,T9 |
| T11 | review | Verify (typecheck/lint/test:core) + review-orchestrator round + PR (AC11) | T5,T10 |
| T12 | verify | Patch release after owner merges; record version (AC12) | T11 |
| T13 | verify | Owner live check in vantage-frontend, 2-3 days (AC13) | T12 |

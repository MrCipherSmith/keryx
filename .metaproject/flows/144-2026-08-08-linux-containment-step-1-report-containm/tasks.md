# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context — requirements package, ADR-0010, affected modules, baseline gate numbers |
| T2 | implement | Implement per plan (umbrella; the concrete edits are T5–T8) |
| T3 | test | Add/adjust tests and make them pass (umbrella; the concrete suites are T9, T10 and the new `probe.test.ts`) |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | `probe.ts`: injectable cached trial containment (AC4, AC5) |
| T6 | implement | `capability-matrix.ts`: third state + Linux kernel-facility axis (R5, R6) |
| T7 | implement | `src/commands/sandbox.ts`: compose the probe into the report (AC6) |
| T8 | implement | `scripts/install.sh`: report from the probe, not `command -v bwrap` (R7, AC12) |
| T9 | test | Extend the doc-sync test to the third state and update the runbook (AC7) |
| T10 | test | Assert no output path names the machine-wide sysctl (AC13) |
| T11 | review | Verify AC8/AC14 by diff: launchers, profile and adapter unchanged |
| T12 | review | Quality gate: `keryx health run`, `bun test` on affected paths, doc-link check |
| T13 | review | Draft PR against `feat/linux-containment-landlock` + review rounds until green |

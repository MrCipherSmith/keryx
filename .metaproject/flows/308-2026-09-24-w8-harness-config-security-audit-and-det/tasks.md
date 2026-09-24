# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan (superseded by T5/T6/T7) |
| T3 | test | Add/adjust tests (superseded: tests ship inside T5/T6) |
| T4 | review | PR, adversarial review/fix loop, CI green |
| T5 | implement | Lane A: audit-harness engine, CLI handler, baseline, apply, labeled fixtures + tests |
| T6 | implement | Lane B: affected/related report builders, impact-evidence provider, config, CLI + tests |
| T7 | implement | Wire subcommands into security.ts, export isPassGate, docs |
| T8 | verify | Run audit-harness on the labeled fixture set end to end; confirm --fix-proposals writes nothing |
| T9 | verify | Confirm impact-evidence importers == `gdgraph affected --json` stdout byte for byte on this repo |
| T10 | verify | Confirm no diff under src/harness and src/integrations (AC17) |

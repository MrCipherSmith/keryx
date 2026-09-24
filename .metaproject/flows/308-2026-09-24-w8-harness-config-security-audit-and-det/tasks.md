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
| T11 | implement | Generalize hook-surface discovery to every non-JSON registry surface; codex config.toml mcp_servers scan |
| T12 | implement | Fix import-policy regressions: no core->client TOML import; route new CLI imports through owner facades |
| T13 | implement | Review round 1 fixes: audit-harness (F2-F10, F16, F20, F21, F23, F24, F27) |
| T14 | implement | Review round 1 fixes: impact-evidence (F1, F11-F15, F17-F19, F22, F25, F26) |
| T15 | implement | Review round 2 fixes: impact-evidence (F11, F14, N5, N8, N10) |
| T16 | implement | Review round 2 fixes: audit-harness (N3, N4, N6, N7, N9) |
| T17 | implement | Re-planned narrow fix: NEW-1 hook root anchoring, NEW-2 failure reason+log, NEW-3 kill switch before path deny (+I1-I3) |

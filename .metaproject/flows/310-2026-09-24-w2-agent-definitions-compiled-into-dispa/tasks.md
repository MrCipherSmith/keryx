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
| T5 | implement | Core src/agents module: types, schema validator, frontmatter, catalog loader, baseline, tool vocabulary, policy map, compiler + tests (AC1, AC2, AC3, AC7) |
| T6 | implement | Ten bundled generic agent definitions in src/gdskills/bundled/agents (AC10) |
| T7 | implement | Exporters + opt-in W5 agents surfaces + matrix regeneration, first-party docs check (AC4, AC9) |
| T8 | implement | CLI keryx agents list/show/export/verify + xref guard + regression (AC5, AC6, AC8) |
| T9 | docs | D-2 cross-reference + agent catalogue guide (AC12) |
| T10 | test | Verify every generic agent passes `keryx agents verify` (AC10) |
| T11 | test | Verify every exporter output scanned clean by audit-harness (AC11) |
| T12 | review | Adversarial PR review round(s) + fix loop |

T2/T3/T4 are umbrella rows: T2 closes when T5–T8 are done, T3 when targeted
tests/typecheck/eslint pass, T4 when the draft PR is open.

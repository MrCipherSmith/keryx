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
| T5 | implement | Lane A: keryx stack detect (src/stack/, command, persistence, determinism) |
| T6 | implement | Lane B: install manifest, plan/apply, install-state, doctor, uninstall |
| T7 | implement | Lane C: governance gates scout/eval/stocktake + authoring lint + metadata.origin |
| T8 | implement | Lane D: minimal python stack pack + stack-pack guard tests |
| T9 | test | Verify: stack detect twice offline on fixture repo, identical output (Wave-2 exit) |
| T10 | test | Verify: scout/eval/stocktake run on the existing bundled catalog; outputs in journal |
| T11 | docs | Docs: W1 spec status + CLI help for stack/skills commands |

T2 and T3 are superseded by the lane tasks T5-T8 (each lane ships its own tests) and are closed as skipped.

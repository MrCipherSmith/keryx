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
| T5 | implement | Register gemini-cli, kiro, github-copilot-agent, zed (ACP) and keryx-shell adapters with codecs, instructions surfaces and probes |
| T6 | implement | Integrations installer core with per-target install-state; legacy installers delegate to it |
| T7 | implement | Generated capability matrix, checked-in artifact, schema validation, guard test and CI step |
| T8 | implement | keryx integrations install/doctor/uninstall/matrix CLI, help and command registry |
| T9 | docs | Docs: integrations page, W5 spec status, matrix artifact reference |
| T10 | test | Verify keryx harness run/exec/extension/wave help and behavior unchanged (pinning test) |
| T11 | test | End-to-end: integrations install/doctor/uninstall on a temp project for every runtime, legacy alias tests unmodified |

T2 closed as skipped: superseded by T5–T9.

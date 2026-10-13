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
| T5 | implement | Remote config: permissionMode, approvalTimeoutMs, runTimeoutMs 0=none; ApprovalDecision always; registration delivery (AC4,AC6,AC8,AC14) |
| T6 | implement | Effective Telegram mode (trust) and allowlist parity in the Telegram approver (AC1,AC2,AC3,AC5,AC15) |
| T7 | implement | Always button on the Telegram prompt with remember offer (AC9,AC10) |
| T8 | implement | /stop topic command, no-limit timer, fix /interrupt text (AC6,AC7) |
| T9 | implement | keryx permissions list|remove and /permissions modal (AC11) |
| T10 | implement | /remote-policy, /settings Telegram group, sidebar posture line, keryx serve status posture (AC12,AC13) |
| T11 | test | Tests: floors parity table, fake-bot e2e for stop/always/expiry, compat of old configs (AC1-AC15) |
| T12 | docs | Docs (README + docs site pages) and version bump (AC16,AC17) |

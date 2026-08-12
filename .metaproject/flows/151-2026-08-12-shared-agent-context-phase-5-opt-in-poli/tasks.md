# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | Verify AccessReceipt ledger integrity before corpus use and append |
| T6 | implement | Build minimized anonymized corpus, manifest, quarantine and deterministic splits |
| T7 | implement | Compare pinned candidate and baseline through fail-closed sandbox evaluation |
| T8 | implement | Gate opt-in with exact pins, kill switch, protected fields and rollback |
| T9 | docs | Publish Phase 5 corpus and evaluation evidence |
| T10 | review | Run focused/full tests, code verifier, health and full clean review |

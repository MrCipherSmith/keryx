# Tasks

Task definitions live here; task **statuses** live in flow.json and are
managed only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title | Notes |
|----|------|-------|-------|
| T1 | context | Collect remaining context | done — spec, templates, lint/test shape, detect.ts tags read this session |
| T2 | implement | Implement per plan (scaffold) | skipped — superseded by T5-T8 |
| T3 | test | Add/adjust tests and make them pass (scaffold) | skipped — superseded by T10 |
| T4 | review | Self-review and prepare draft PR (scaffold) | skipped — superseded by T11 |
| T5 | implement | php-laravel stack pack (sonnet worker) | |
| T6 | implement | ruby-rails stack pack (sonnet worker) | |
| T7 | implement | c-cpp stack pack (sonnet worker) | |
| T8 | implement | sql-db stack pack (sonnet worker) | |
| T9 | implement | Shared wiring: install-manifest.json, STACK_EXTENSIONS, W1/W2 docs (runner only) | |
| T10 | test | Offline verification: stack-packs, authoring-lint, eval-integrity, manifest tests | |
| T11 | review | Commit packs separately, push branch, return READY_FOR_GATE | |

# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context — already satisfied by the prd-creator/trd-creator investigation in `docs/requirements/keryx-tui-busy-mode-command/`; mark done immediately with a journal note. |
| T2 | implement | Implement per TRD §1.2-§1.3: extract `/mode`'s logic into `runModeCommand`, wire the new `"mode"` busy-dispatch case, extend `classifyBusyDispatch`, add the two test cases (§8). Tests are part of this task. |
| T3 | test | Confirm the full suite (typecheck + `bun test`) passes including the new tests added in T2. |
| T4 | review | Run `code-verifier` then `review-orchestrator` on the diff, fix any findings, prepare the PR. |

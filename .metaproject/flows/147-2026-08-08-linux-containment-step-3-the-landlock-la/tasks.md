# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

T1–T4 are the flow-init defaults and are kept as the umbrella entries; T5–T17
are this flow's real work, in build order.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | context | read the spike FFI reference, ADR-0010 and specification §4.4; produce the porting notes and the proposed grant set |
| T6 | test | tests for the grant model: AC1 profiles, AC2 refusals, deny-list-under-a-granted-root |
| T7 | implement | rework landlock.ts to the grant model (handle read rights, grant roots, check the deny list) |
| T8 | test | tests for layer selection in wrap.ts and the resolved layer in detect.ts (AC3, AC8) |
| T9 | implement | implement landlock-exec.ts: FFI applier, PATH resolution that refuses, execve, exit-status mapping |
| T10 | test | live enforcement tests with negative controls (AC4, AC5, AC6, AC7), skipped-with-reason below ABI 3 |
| T11 | implement | wire the Linux branch: wrap.ts layer choice, detect.ts layer field, adapter and callers unchanged |
| T12 | implement | prebundle landlock-exec to a single .js in the build step and resolve its path for dev and installed runs |
| T13 | implement | record the layer that ran in the run receipt and in sandbox status, from the parent (AC10) |
| T14 | review | measure the benign `$HOME` grant set against real commands; record each granted entry as a reviewed widening |
| T15 | review | decide and record the newer-kernel ABI-clamp position and the environment-forwarding position |
| T16 | docs | correct every document this flow's own changes falsify (os-sandbox surface docs, wiki, guide) |
| T17 | review | quality gate and review-orchestrator until green (AC11) |

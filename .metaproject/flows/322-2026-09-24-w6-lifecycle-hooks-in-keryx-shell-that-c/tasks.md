# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan (superseded by T5-T10) |
| T3 | test | Add/adjust tests (superseded by T7, T11) |
| T4 | review | Self-review and prepare draft PR (superseded by T12) |
| T5 | implement | Core hook runtime module src/harness/hooks with unit tests (AC5, AC6 schema copy, AC11 ports, AC13, AC14) |
| T6 | implement | run.ts integration + hook_invocation records + subagent start/stop external/internal (AC1, AC3, AC7, AC8, AC15) |
| T7 | test | Guard + failure-semantics matrix tests (AC2 exit criterion, AC4, AC5, AC9) |
| T8 | implement | `keryx hooks` CLI (AC6, AC10, AC12) |
| T9 | implement | keryx shell runAgentTurn wiring, trigger/schedule interactive:false, production deps, PreCompact (AC9, AC15) |
| T10 | docs | User doc + W3/W8 extension points |
| T11 | test | End-to-end verification through `bun ./src/cli.ts hooks …` with a real sandboxed hook |
| T12 | review | Local checks, draft PR on stack/wave0, adversarial review/fix loop, CI green (AC16) |

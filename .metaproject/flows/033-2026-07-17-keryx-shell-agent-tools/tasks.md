# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Context: SA-01 RFC, run.ts/tool/policy contracts, provider tool protocol, baseline 1369 (done at init) |
| T2 | implement | Builtin read-only tools + executor (`get_cwd`/`list_dir`/`read_file`, root-confined); agent driver `runAgentTurn`; orient context builder; `--agent`/`/agent` wiring + onToolCall/onToolResult UI |
| T3 | test | Unit tests: tools (happy/escape/missing), driver (FakeProvider tool-call transcript feeds result back), context builder (orient present/absent); keep chat-core tests unchanged; suite ≥ 1369 pass |
| T4 | review | Self-review, `tsc --noEmit`, full `bun test`, live smoke (`--agent`: real cwd/list, no hallucination) in journal, draft PR |

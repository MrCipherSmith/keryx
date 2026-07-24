# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | implement | Add `src/tui/herdr-report.ts` reporter module (socket protocol, env gate, state mapping) |
| T2 | test | Add `src/tui/herdr-report.test.ts` (bun:test) covering gate/no-op/payload/dedup/seq/release |
| T3 | implement | Wire the reporter into `src/tui/tui-shell.ts` (`setMainAgent` + `finally` release) |
| T4 | review | Verify (bun test + tsc + live socket smoke), self-review, open draft PR |

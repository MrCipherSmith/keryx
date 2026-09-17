# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

The four scaffold rows (T1-T4) are superseded by the split below — this is a
three-independent-pieces flow, not a single implement/test/review pass — and
closed with `--disposition skipped --reason "superseded by P1/P2/P3 split"`,
except T1 (context), which is closed `done` because the context gathering it
names already happened directly (gdgraph/ctx rg reads of `tui-shell.ts`,
`shell-chrome.ts`, `theme.ts`, `theme-picker.ts`, `modal-host.ts`,
`shell-chrome.test.ts`, `shell-pty-launch.smoke.test.ts` — see plan.md).

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | P1: boot-animation.ts + tui-shell.ts wiring + smoke-test skip hatch |
| T6 | implement | P2: sidebar `sidebarTop` -> `ScrollBoxRenderable` |
| T7 | implement | P3: sidebar version display next to title |
| T8 | test | Verification: focused tests, `code-verifier`, `keryx health run` |
| T9 | review | `review-orchestrator` pass over the full diff |

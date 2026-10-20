# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

T1–T4 were the `flow init` scaffold: T1 is done (the investigation in `context.md`); T2–T4 are skipped, superseded by the per-phase tasks below. Phases run in sequence (operator decision: three PRs, A → B → C), so each phase's first task depends on the previous phase's merge.

| ID | Kind | Depends | Title | Criteria |
|----|------|---------|-------|----------|
| T1 | context | — | Collect remaining context | — |
| T2 | implement | — | Implement per plan (skipped, superseded) | — |
| T3 | test | — | Add/adjust tests (skipped, superseded) | — |
| T4 | review | — | Self-review and draft PR (skipped, superseded) | — |
| T5 | test | — | A routing: red tests for the empty startup catalog, cache hygiene and every `/routing` visible state | AC1–AC4 |
| T6 | implement | T5 | A routing: startup detection, zero-provider cache rule, current-session row, visible fallback reasons, docs | AC1–AC4 |
| T7 | verify | T6 | A routing: manual check on the branch build (skipped → T20) | — |
| T8 | review | T6 | A routing: PR 1 review rounds, merge into main, release | — |
| T20 | verify | T8 | A routing: operator check after the PR 1 release, keryx installed from npm | AC5 |
| T9 | test | T8 | B setup: red tests for step model, detection, generated prompt, readable scrolling modal, copy and Run | AC6–AC10 |
| T10 | implement | T9 | B setup: step model, full step lists, scenario detection, generated prompt, CLI output | AC6–AC8 |
| T11 | implement | T10 | B setup: modal layout, contrast, scroll, buttons, Run through the external agent with main-agent fallback, docs | AC8–AC10 |
| T12 | verify | T11 | B setup: manual check on the branch build (skipped → T21) | — |
| T13 | review | T11 | B setup: PR 2 review rounds, merge into main, release | — |
| T21 | verify | T13 | B setup: operator check after the PR 2 release, keryx installed from npm | AC11 |
| T14 | test | T13 | C sidebar: red tests for card projection, mode geometry, `tui.json` merge, header buttons, wide-mode modal width | AC12–AC17 |
| T15 | implement | T14 | C sidebar: geometry store, pinned header with mode buttons and shortcut, persistence, width plumbing, modal sizing | AC13–AC16 |
| T16 | implement | T15 | C sidebar: seven cards with detail modals, attention badges, rail glyphs, theme repaint, docs | AC12, AC13, AC17 |
| T17 | verify | T16 | C sidebar: combined check (skipped → split into T22 and T23) | — |
| T22 | verify | T16 | C sidebar: run the 80×24 pty smoke locally before merge | AC16 |
| T18 | review | T22 | C sidebar: PR 3 review rounds, merge into main, release | — |
| T23 | verify | T18 | C sidebar: operator check after the PR 3 release on a laptop screen, keryx installed from npm | AC18 |
| T19 | verify | T23 | Final: operator check in vantage-frontend on the released npm keryx | AC19 |

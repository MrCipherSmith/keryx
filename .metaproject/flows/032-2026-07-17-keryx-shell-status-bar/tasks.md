# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Context: flow-031 wrapper seam (createRichIo), ui.ts, baseline 1364 (done at init) |
| T2 | implement | `src/lib/statusbar.ts` (pure `formatStatusBar` + `scrollRegion` CSI builders); wire pinned bar into `createRichIo`/`shellCommand` with SIGWINCH + exit/SIGINT cleanup and safe degradation |
| T3 | test | `src/lib/statusbar.test.ts`: formatStatusBar (home-collapse, truncation width, NO_COLOR plain) + scrollRegion CSI codes/reset; keep suite offline/deterministic ≥ 1364 pass |
| T4 | review | Self-review, `tsc --noEmit`, full `bun test`, manual live smoke (pinned bar, resize, Ctrl-C/exit restore) in journal, stacked draft PR onto flow 031 |

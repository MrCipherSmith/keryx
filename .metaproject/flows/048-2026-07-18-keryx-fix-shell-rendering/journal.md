# Flow Journal

- 2026-07-18T19:08:38.598Z - flow created
- 2026-07-18T19:08:38.703Z - frozen: 3 criteria; checksum recorded
- 2026-07-18T19:08:38.798Z - started
- 2026-07-18T19:08:38.877Z - task-done: T1: Collect remaining context

## Phase 2/3 — implementation + verification (orchestrator)
- shell.ts: removed the flow-032 pinned status bar — createRichIo no longer takes a StatusSource, and enterBar/exitBar/redrawBar/drawBar, the DECSTBM scrollRegion enter/exit, MIN_BAR_ROWS, and the SIGWINCH/SIGINT/exit scroll-region handlers are gone. shellCommand dropped the tracking factory (bar-only) and enterBar()/exitBar(); runAgentRepl dropped redrawBar. No terminal row is reserved → node:readline regains full screen control (fixes input-over-bar + lost output).
- printHeader now shows the cwd: subtitle = `<provider>/<model> · agent · <collapseHome(cwd)>` (one-time header, not a pinned bar). Header, `❯` prompt, thinking spinner, streaming, markdown, tool rendering unchanged.
- statusbar.ts kept (collapseHome reused for the header; scrollRegion/formatStatusBar now unused but still exported + tested).
- Independent verify: `bunx tsc --noEmit` clean; `bun test` **1452 pass / 3 skip / 0 fail** (= baseline). No `scrollRegion(`/region-set `[<n>r` in shell.ts. Non-TTY smoke: header shows cwd, 0 DECSTBM escapes emitted.
- NOTE (separate, lower severity): the chat-mode onTurnEnd markdown re-render still does a cursor-up in-place restyle — chat-only, fires only when markdown differs; a potential future follow-up if it glitches with readline. Agent mode does not use it.
- AC1–AC3 satisfied (AC3 live-TTY smoke = user).
- 2026-07-18T19:14:02.141Z - task-done: T2: Implement per plan
- 2026-07-18T19:14:02.227Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-18T19:14:02.312Z - task-done: T4: Self-review and prepare draft PR
